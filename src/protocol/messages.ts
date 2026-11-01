import type { NamedEffort } from '../catalog/reasoning.ts';
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
import {
	createToolCallBuffer,
	isRecord,
	joinUrl,
	jsonHeaders,
	parseData,
	readNumber,
	readString,
} from './wire.ts';

/** The Anthropic Messages wire format. */
export const messagesAdapter: ProtocolAdapter = {
	id: 'messages',
	buildRequest,
	startStream: createStreamDecoder,
};

/** Pinned so a server-side default change cannot alter request parsing. */
const API_VERSION = '2023-06-01';

/**
 * Reasoning budget per effort level, in tokens.
 *
 * The Messages API takes a budget rather than a level, and the catalog only names the levels a
 * model accepts. These values are the published anchors for the levels Anthropic documents; the
 * model's own bounds clamp them.
 */
const BUDGET_BY_EFFORT: Readonly<Record<NamedEffort, number>> = {
	minimal: 1_024,
	low: 2_048,
	medium: 8_192,
	high: 16_384,
	xhigh: 24_576,
	max: 32_768,
};

function buildRequest(input: BuildInput): ProtocolRequest {
	const body: Record<string, unknown> = {
		model: input.modelId,
		max_tokens: input.maxOutputTokens,
		messages: toMessages(input.messages),
		stream: true,
	};

	if (input.tools.length > 0) {
		body.tools = input.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
		if (input.requireToolCall) {
			body.tool_choice = { type: 'any' };
		}
	}

	const thinking = toThinking(input);
	if (thinking !== undefined) {
		body.thinking = thinking;
	}

	return {
		url: joinUrl(input.baseUrl, 'messages'),
		headers: { ...jsonHeaders(), 'x-api-key': input.apiKey, 'anthropic-version': API_VERSION },
		body: JSON.stringify(body),
	};
}

function toThinking(input: BuildInput): Record<string, unknown> | undefined {
	const effort = input.reasoning.choice;
	if (effort === undefined || effort === 'enabled') {
		return undefined;
	}

	if (effort === 'disabled') {
		return { type: 'disabled' };
	}

	const min = input.reasoning.budget?.min ?? 1_024;
	// The budget must leave room for the reply, so the output cap bounds it too.
	const ceiling = Math.min(
		input.reasoning.budget?.max ?? BUDGET_BY_EFFORT.max,
		input.maxOutputTokens - 1,
	);
	if (ceiling < min) {
		return undefined;
	}

	return {
		type: 'enabled',
		budget_tokens: Math.min(Math.max(BUDGET_BY_EFFORT[effort], min), ceiling),
	};
}

/**
 * Convert turns to content blocks.
 *
 * This API is stricter than the others: it wants tool results in a `user` turn and expects roles to
 * alternate, so consecutive turns of one role are merged rather than sent as separate messages.
 */
function toMessages(messages: readonly NeutralMessage[]): unknown[] {
	const wire: { role: string; content: unknown[] }[] = [];

	const append = (role: string, content: unknown[]): void => {
		if (content.length === 0) {
			return;
		}

		const previous = wire.at(-1);
		if (previous !== undefined && previous.role === role) {
			previous.content.push(...content);

			return;
		}

		wire.push({ role, content });
	};

	for (const message of messages) {
		if (message.role === 'user') {
			append('user', userBlocks(message));
			continue;
		}

		append('assistant', assistantBlocks(message));
		append('user', message.toolResults.map(toolResultBlock));
	}

	return wire;
}

function userBlocks(message: NeutralMessage): unknown[] {
	return [
		...(message.text === '' ? [] : [{ type: 'text', text: message.text }]),
		...message.images.map(imageBlock),
	];
}

function assistantBlocks(message: NeutralMessage): unknown[] {
	return [
		// Replayed reasoning is dropped: a thinking block without its signature is
		// rejected, and the host round-trip does not carry one.
		...(message.text === '' ? [] : [{ type: 'text', text: message.text }]),
		...message.toolCalls.map((call) => ({
			type: 'tool_use',
			id: call.callId,
			name: call.name,
			input: parseArguments(call.arguments),
		})),
	];
}

function toolResultBlock(result: NeutralToolResult): unknown {
	if (result.images.length === 0) {
		return { type: 'tool_result', tool_use_id: result.callId, content: result.text };
	}

	return {
		type: 'tool_result',
		tool_use_id: result.callId,
		content: [
			...(result.text === '' ? [] : [{ type: 'text', text: result.text }]),
			...result.images.map(imageBlock),
		],
	};
}

function imageBlock(image: NeutralImage): unknown {
	return {
		type: 'image',
		source: {
			type: 'base64',
			media_type: image.mimeType,
			data: Buffer.from(image.data).toString('base64'),
		},
	};
}

function parseArguments(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// A tool_use block must carry an object; sending malformed text would fail
		// the whole request, so an empty input replays more usefully.
		return {};
	}
}

function createStreamDecoder(): StreamDecoder {
	const calls = createToolCallBuffer();
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;

	return {
		push(event: SseEvent): NeutralEvent[] {
			const data = parseData(event);
			if (data === undefined) {
				return [];
			}

			const events: NeutralEvent[] = [];

			switch (readString(data.type)) {
				case 'message_start': {
					const usage = isRecord(data.message) ? data.message.usage : undefined;
					inputTokens = isRecord(usage)
						? (readNumber(usage.input_tokens) ?? inputTokens)
						: inputTokens;
					break;
				}

				case 'content_block_start': {
					const block = isRecord(data.content_block) ? data.content_block : undefined;
					if (block !== undefined && readString(block.type) === 'tool_use') {
						calls.push(readNumber(data.index) ?? 0, {
							callId: readString(block.id),
							name: readString(block.name),
						});
					}
					break;
				}

				case 'content_block_delta': {
					events.push(...readBlockDelta(data, calls));
					break;
				}

				case 'message_delta': {
					outputTokens = isRecord(data.usage)
						? (readNumber(data.usage.output_tokens) ?? outputTokens)
						: outputTokens;
					break;
				}

				default:
					break;
			}

			return events;
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

function readBlockDelta(
	data: Record<string, unknown>,
	calls: ReturnType<typeof createToolCallBuffer>,
): NeutralEvent[] {
	const delta = isRecord(data.delta) ? data.delta : undefined;
	if (delta === undefined) {
		return [];
	}

	switch (readString(delta.type)) {
		case 'text_delta': {
			const text = readString(delta.text);

			return text === undefined || text === '' ? [] : [{ kind: 'text', text }];
		}

		case 'thinking_delta': {
			const text = readString(delta.thinking);

			return text === undefined || text === '' ? [] : [{ kind: 'thinking', text }];
		}

		case 'input_json_delta':
			calls.push(readNumber(data.index) ?? 0, { arguments: readString(delta.partial_json) ?? '' });

			return [];

		default:
			return [];
	}
}
