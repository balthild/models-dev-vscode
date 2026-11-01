import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { NeutralEvent } from '#/protocol/index.ts';
import {
	REASONING_METADATA,
	adapterFor,
	readReasoningState,
	reasoningMetadata,
	replayableReasoning,
} from '#/protocol/index.ts';

describe('REASONING_METADATA', () => {
	test('names the keys the host preserves when it rebuilds a conversation', () => {
		assert.deepEqual(REASONING_METADATA, {
			signature: 'signature',
			complete: '_completeThinking',
			redacted: 'redactedData',
		});
	});
});

describe('readReasoningState', () => {
	test('reads the state off a reasoning part', () => {
		const state = readReasoningState({
			id: 'rs_1',
			metadata: {
				[REASONING_METADATA.signature]: 'sig',
				[REASONING_METADATA.complete]: 'full',
				[REASONING_METADATA.redacted]: 'payload',
			},
		});

		assert.deepEqual(state, {
			id: 'rs_1',
			signature: 'sig',
			complete: 'full',
			redacted: 'payload',
		});
	});

	test('finds nothing on a part that carries only display text', () => {
		assert.deepEqual(readReasoningState({ value: 'just text' }), {
			id: undefined,
			signature: undefined,
			complete: undefined,
			redacted: undefined,
		});
	});

	test('ignores metadata values that are not strings', () => {
		assert.equal(readReasoningState({ metadata: { signature: 42 } }).signature, undefined);
	});

	test('tolerates a part that is not an object at all', () => {
		assert.equal(readReasoningState(undefined).id, undefined);
		assert.equal(readReasoningState('nope').signature, undefined);
	});
});

describe('replayableReasoning', () => {
	test('replays a signed block together with its full text', () => {
		assert.deepEqual(replayableReasoning({ signature: 'sig', complete: 'weighing' }), {
			id: undefined,
			text: 'weighing',
			signature: 'sig',
		});
	});

	test('keeps the part id, which the Responses API replays against', () => {
		assert.equal(replayableReasoning({ id: 'rs_1', signature: 'sig' })?.id, 'rs_1');
	});

	test('replays a withheld block in place of its text', () => {
		assert.deepEqual(replayableReasoning({ redacted: 'payload', complete: 'ignored' }), {
			id: undefined,
			text: '',
			redacted: 'payload',
		});
	});

	test('drops a block with no proof it came from the model', () => {
		assert.equal(replayableReasoning({ complete: 'display text only' }), undefined);
		assert.equal(replayableReasoning({}), undefined);
		assert.equal(replayableReasoning({ signature: '' }), undefined);
	});
});

describe('reasoningMetadata', () => {
	test('carries only the state that is present', () => {
		assert.deepEqual(reasoningMetadata({ text: 'weighing', signature: 'sig' }), {
			[REASONING_METADATA.signature]: 'sig',
			[REASONING_METADATA.complete]: 'weighing',
		});
	});

	test('leaves out empty text, which adds nothing to a replay', () => {
		assert.deepEqual(reasoningMetadata({ text: '', redacted: 'payload' }), {
			[REASONING_METADATA.redacted]: 'payload',
		});
	});
});

describe('round trip', () => {
	/** Feed wire frames through a fresh decoder, as the provider does while a turn streams. */
	function decodeMessages(frames: readonly unknown[]): NeutralEvent[] {
		const decoder = adapterFor('messages').startStream();

		return frames.flatMap((frame) => decoder.push({ data: JSON.stringify(frame) }));
	}

	/** The one part the provider would report as replay state. */
	function thinkingState(events: readonly NeutralEvent[]): NeutralEvent | undefined {
		return events.find((event) => event.kind === 'thinkingState');
	}

	test('a signed block from the stream is replayed in the next request', () => {
		const events = decodeMessages([
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
			{
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'weighing' },
			},
			{
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'signature_delta', signature: 'sig' },
			},
			{ type: 'content_block_stop', index: 0 },
		]);
		const state = thinkingState(events);
		assert.equal(state?.kind, 'thinkingState');

		if (state?.kind !== 'thinkingState') {
			return;
		}

		// What the provider reports to the host, and what the host hands back next turn.
		const part = { id: state.id, value: '', metadata: reasoningMetadata(state) };
		const replayed = replayableReasoning(readReasoningState(part));
		assert.deepEqual(replayed, { id: undefined, text: 'weighing', signature: 'sig' });

		const request = adapterFor('messages').buildRequest({
			modelId: 'model',
			baseUrl: 'https://example.test/v1',
			apiKey: 'secret',
			messages: [
				{
					role: 'assistant',
					text: 'answer',
					images: [],
					toolCalls: [],
					toolResults: [],
					reasoning: replayed === undefined ? [] : [replayed],
				},
			],
			tools: [],
			requireToolCall: false,
			maxOutputTokens: 1_000,
			reasoning: {},
		});
		const body = JSON.parse(request.body) as { messages: { content: unknown[] }[] };

		assert.deepEqual(body.messages[0].content[0], {
			type: 'thinking',
			thinking: 'weighing',
			signature: 'sig',
		});
	});
});
