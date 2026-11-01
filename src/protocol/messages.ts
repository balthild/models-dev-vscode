import type { NamedEffort } from '#/catalog/reasoning.ts';

import type {
	BuildInput,
	NeutralEvent,
	NeutralImage,
	NeutralMessage,
	NeutralReasoning,
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
		// Reasoning has to lead the assistant content, and a block the model did not sign would
		// be rejected, so only verified blocks get here.
		...message.reasoning.map(reasoningBlock),
		...(message.text === '' ? [] : [{ type: 'text', text: message.text }]),
		...message.toolCalls.map((call) => ({
			type: 'tool_use',
			id: call.callId,
			name: call.name,
			input: parseArguments(call.arguments),
		})),
	];
}

/** Rebuild a reasoning block, which is either withheld or signed. */
function reasoningBlock(reasoning: NeutralReasoning): unknown {
	if (reasoning.redacted !== undefined) {
		return { type: 'redacted_thinking', data: reasoning.redacted };
	}

	return { type: 'thinking', thinking: reasoning.text, signature: reasoning.signature ?? '' };
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

/** Reasoning accumulated for one open content block. */
interface ThinkingBlock {
	text: string;
	signature: string;
}

function createStreamDecoder(): StreamDecoder {
	const calls = createToolCallBuffer();
	// Keyed by block index, which is how the stream addresses a block across events.
	const blocks = new Map<number, ThinkingBlock>();
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;

	const closeThinkingBlock = (index: number): NeutralEvent[] => {
		const block = blocks.get(index);
		if (block === undefined) {
			return [];
		}

		blocks.delete(index);

		// Without a signature the block cannot be replayed, so it is dropped here rather than
		// offered to a request that would be rejected for it.
		if (block.signature === '' || block.text === '') {
			return [];
		}

		return [{ kind: 'thinkingState', text: block.text, signature: block.signature }];
	};

	return {
		push(event: SseEvent): NeutralEvent[] {
			const data = parseData(event);
			if (data === undefined) {
				return [];
			}

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
					const index = readNumber(data.index) ?? 0;

					if (block !== undefined && readString(block.type) === 'tool_use') {
						calls.push(index, {
							callId: readString(block.id),
							name: readString(block.name),
						});
					} else if (block !== undefined && readString(block.type) === 'thinking') {
						blocks.set(index, { text: '', signature: '' });
					}
					break;
				}

				case 'content_block_delta': {
					return readBlockDelta(data, calls, blocks);
				}

				case 'content_block_stop':
					return closeThinkingBlock(readNumber(data.index) ?? 0);

				case 'message_delta': {
					outputTokens = isRecord(data.usage)
						? (readNumber(data.usage.output_tokens) ?? outputTokens)
						: outputTokens;
					break;
				}

				default:
					break;
			}

			return [];
		},

		flush(): NeutralEvent[] {
			const events = [...blocks.keys()].flatMap((index) => closeThinkingBlock(index));
			events.push(...calls.flush());
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
	blocks: Map<number, ThinkingBlock>,
): NeutralEvent[] {
	const delta = isRecord(data.delta) ? data.delta : undefined;
	if (delta === undefined) {
		return [];
	}

	const block = blocks.get(readNumber(data.index) ?? 0);

	switch (readString(delta.type)) {
		case 'text_delta': {
			const text = readString(delta.text);

			return text === undefined || text === '' ? [] : [{ kind: 'text', text }];
		}

		case 'thinking_delta': {
			const text = readString(delta.thinking);
			if (text === undefined || text === '' || block === undefined) {
				return [];
			}

			// The full text is kept for replay, since the state event is only sent once.
			block.text += text;

			return [{ kind: 'thinking', text }];
		}

		case 'signature_delta': {
			// Arrives as the block closes, after the text it signs.
			if (block !== undefined) {
				block.signature += readString(delta.signature) ?? '';
			}

			return [];
		}

		case 'input_json_delta':
			calls.push(readNumber(data.index) ?? 0, { arguments: readString(delta.partial_json) ?? '' });

			return [];

		default:
			return [];
	}
}
