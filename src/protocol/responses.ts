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
	readNumber,
	readString,
} from './wire.ts';

/**
 * The OpenAI Responses wire format.
 *
 * Requests are stateless: the full history is resent each turn with `store: false`, so no
 * server-side conversation has to be tracked or cleaned up.
 */
export const responsesAdapter: ProtocolAdapter = {
	id: 'responses',
	buildRequest,
	startStream: createStreamDecoder,
};

function buildRequest(input: BuildInput): ProtocolRequest {
	const body: Record<string, unknown> = {
		model: input.modelId,
		input: toInput(input.messages),
		stream: true,
		store: false,
		max_output_tokens: input.maxOutputTokens,
	};

	if (input.tools.length > 0) {
		body.tools = input.tools.map((tool) => ({
			type: 'function',
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
		body.tool_choice = input.requireToolCall ? 'required' : 'auto';
	}

	const effort = input.reasoning.choice;
	if (effort !== undefined && effort !== 'enabled') {
		body.reasoning = { effort: effort === 'disabled' ? 'none' : effort };
	}

	return {
		url: joinUrl(input.baseUrl, 'responses'),
		headers: { ...jsonHeaders(), authorization: `Bearer ${input.apiKey}` },
		body: JSON.stringify(body),
	};
}

function toInput(messages: readonly NeutralMessage[]): unknown[] {
	const input: unknown[] = [];

	for (const message of messages) {
		input.push(...messageItems(message));

		for (const result of message.toolResults) {
			input.push(outputItem(result));
		}
	}

	return input;
}

function messageItems(message: NeutralMessage): unknown[] {
	if (message.role === 'user') {
		return [
			{
				type: 'message',
				role: 'user',
				content: [
					...(message.text === '' ? [] : [{ type: 'input_text', text: message.text }]),
					...message.images.map((image) => inputImage(image)),
				],
			},
		];
	}

	const items: unknown[] = [];

	if (message.text !== '') {
		items.push({
			type: 'message',
			role: 'assistant',
			content: [{ type: 'output_text', text: message.text }],
		});
	}

	for (const call of message.toolCalls) {
		items.push({
			type: 'function_call',
			call_id: call.callId,
			name: call.name,
			arguments: call.arguments,
		});
	}

	return items;
}

function outputItem(result: NeutralToolResult): unknown {
	return {
		type: 'function_call_output',
		call_id: result.callId,
		output:
			result.text === '' && result.images.length === 0
				? '(no output)'
				: [
						...(result.text === '' ? [] : [{ type: 'input_text', text: result.text }]),
						...result.images.map((image) => inputImage(image)),
					],
	};
}

function inputImage(image: NeutralImage): unknown {
	return {
		type: 'input_image',
		image_url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`,
	};
}

function createStreamDecoder(): StreamDecoder {
	const calls: ToolCallBuffer = createToolCallBuffer();
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;

	return {
		push(event: SseEvent): NeutralEvent[] {
			const data = parseData(event);
			if (data === undefined) {
				return [];
			}

			switch (readString(data.type)) {
				case 'response.output_text.delta': {
					const text = readString(data.delta);

					return text === undefined || text === '' ? [] : [{ kind: 'text', text }];
				}

				case 'response.reasoning_summary_text.delta':
				case 'response.reasoning_text.delta': {
					const text = readString(data.delta);

					return text === undefined || text === '' ? [] : [{ kind: 'thinking', text }];
				}

				case 'response.output_item.added': {
					const item = isRecord(data.item) ? data.item : undefined;
					if (item !== undefined && readString(item.type) === 'function_call') {
						calls.push(readString(item.id) ?? '', {
							callId: readString(item.call_id),
							name: readString(item.name),
						});
					}

					return [];
				}

				case 'response.function_call_arguments.delta':
					calls.push(readString(data.item_id) ?? '', { arguments: readString(data.delta) ?? '' });

					return [];

				case 'response.completed': {
					const usage = isRecord(data.response) ? data.response.usage : undefined;
					if (isRecord(usage)) {
						inputTokens = readNumber(usage.input_tokens) ?? inputTokens;
						outputTokens = readNumber(usage.output_tokens) ?? outputTokens;
					}

					return [];
				}

				default:
					return [];
			}
		},

		flush(): NeutralEvent[] {
			const events = calls.flush();
			if (inputTokens !== undefined || outputTokens !== undefined) {
				events.push({ kind: 'usage', inputTokens, outputTokens });
			}

			return events;
		},
	};
}
