import type {
	BuildInput,
	NeutralEvent,
	NeutralImage,
	NeutralMessage,
	NeutralToolResult,
	ProtocolAdapter,
	ProtocolRequest,
	SseEvent,
	StreamDecoder,
} from './types.ts';
import type { ToolCallBuffer } from './wire.ts';
import {
	createToolCallBuffer,
	isRecord,
	joinUrl,
	jsonHeaders,
	parseData,
	readArray,
	readNumber,
	readReasoningText,
	readString,
} from './wire.ts';

/**
 * The OpenAI Chat Completions wire format, which most providers in the catalog speak through an
 * OpenAI-compatible endpoint.
 */
export const chatCompletionsAdapter: ProtocolAdapter = {
	id: 'chatCompletions',
	buildRequest,
	startStream: createStreamDecoder,
};

function buildRequest(input: BuildInput): ProtocolRequest {
	const body: Record<string, unknown> = {
		model: input.modelId,
		messages: toMessages(input.messages),
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: input.maxOutputTokens,
	};

	if (input.tools.length > 0) {
		body.tools = input.tools.map((tool) => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
		body.tool_choice = input.requireToolCall ? 'required' : 'auto';
	}

	const effort = input.reasoning.choice;
	if (effort !== undefined && effort !== 'enabled') {
		// `none` is the level these endpoints use to switch reasoning off; a model
		// whose provider uses some other off switch is left reasoning at its
		// default rather than sent a field it does not understand.
		body.reasoning_effort = effort === 'disabled' ? 'none' : effort;
	}

	return {
		url: joinUrl(input.baseUrl, 'chat/completions'),
		headers: { ...jsonHeaders(), authorization: `Bearer ${input.apiKey}` },
		body: JSON.stringify(body),
	};
}

function toMessages(messages: readonly NeutralMessage[]): unknown[] {
	const wire: unknown[] = [];

	for (const message of messages) {
		if (message.role === 'user') {
			wire.push({ role: 'user', content: userContent(message) });
			continue;
		}

		wire.push({
			role: 'assistant',
			content: message.text === '' ? null : message.text,
			...(message.toolCalls.length === 0
				? {}
				: {
						tool_calls: message.toolCalls.map((call) => ({
							id: call.callId,
							type: 'function',
							function: { name: call.name, arguments: call.arguments },
						})),
					}),
		});

		// Tool results are their own turns in this format, and must follow the
		// assistant turn that asked for them.
		for (const result of message.toolResults) {
			wire.push({ role: 'tool', tool_call_id: result.callId, content: toolResultContent(result) });
		}
	}

	return wire;
}

function userContent(message: NeutralMessage): unknown {
	if (message.images.length === 0) {
		return message.text;
	}

	return [
		...(message.text === '' ? [] : [{ type: 'text', text: message.text }]),
		...message.images.map(imagePart),
	];
}

function toolResultContent(result: NeutralToolResult): unknown {
	if (result.images.length === 0) {
		return result.text;
	}

	return [
		...(result.text === '' ? [] : [{ type: 'text', text: result.text }]),
		...result.images.map(imagePart),
	];
}

function imagePart(image: NeutralImage): unknown {
	return {
		type: 'image_url',
		image_url: {
			url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`,
		},
	};
}

function createStreamDecoder(): StreamDecoder {
	const calls = createToolCallBuffer();

	return {
		push(event: SseEvent): NeutralEvent[] {
			const data = parseData(event);
			if (data === undefined) {
				return [];
			}

			const events = readChoice(data, calls);
			const usage = readUsage(data);
			if (usage !== undefined) {
				events.push(usage);
			}

			return events;
		},

		flush: () => calls.flush(),
	};
}

function readChoice(data: Record<string, unknown>, calls: ToolCallBuffer): NeutralEvent[] {
	const choice = readArray(data.choices)?.[0];
	const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
	if (delta === undefined) {
		return [];
	}

	const events: NeutralEvent[] = [];

	const text = readString(delta.content);
	if (text !== undefined && text !== '') {
		events.push({ kind: 'text', text });
	}

	const reasoning = readReasoningText(delta);
	if (reasoning !== undefined) {
		events.push({ kind: 'thinking', text: reasoning });
	}

	for (const [position, call] of (readArray(delta.tool_calls) ?? []).entries()) {
		if (!isRecord(call)) {
			continue;
		}

		const fn = isRecord(call.function) ? call.function : {};

		// Models that report several calls in one delta key them by index; the
		// position is the fallback when a provider omits it.
		calls.push(readNumber(call.index) ?? position, {
			callId: readString(call.id),
			name: readString(fn.name),
			arguments: readString(fn.arguments),
		});
	}

	return events;
}

function readUsage(data: Record<string, unknown>): NeutralEvent | undefined {
	if (!isRecord(data.usage)) {
		return undefined;
	}

	const inputTokens = readNumber(data.usage.prompt_tokens);
	const outputTokens = readNumber(data.usage.completion_tokens);
	if (inputTokens === undefined && outputTokens === undefined) {
		return undefined;
	}

	return { kind: 'usage', inputTokens, outputTokens };
}
