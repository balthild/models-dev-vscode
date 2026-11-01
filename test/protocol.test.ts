import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { adapterFor } from '#/protocol/index.ts';
import { createSseParser } from '#/protocol/sse.ts';
import type { BuildInput, NeutralEvent, ProtocolAdapter, SseEvent } from '#/protocol/types.ts';

function input(overrides: Partial<BuildInput> = {}): BuildInput {
	return {
		modelId: 'model',
		baseUrl: 'https://example.test/v1',
		apiKey: 'secret',
		messages: [
			{ role: 'user', text: 'hi', images: [], toolCalls: [], toolResults: [], reasoning: [] },
		],
		tools: [],
		requireToolCall: false,
		maxOutputTokens: 1_000,
		reasoning: {},
		...overrides,
	};
}

/** Build a request and parse its body, which every assertion below needs. */
function request(id: ProtocolAdapter['id'], overrides: Partial<BuildInput> = {}) {
	const built = adapterFor(id).buildRequest(input(overrides));

	return { ...built, json: JSON.parse(built.body) as Record<string, any> };
}

/** Feed wire frames through a fresh decoder and collect everything it reports. */
function decode(id: ProtocolAdapter['id'], payloads: unknown[]): NeutralEvent[] {
	const decoder = adapterFor(id).startStream();
	const frames: SseEvent[] = payloads.map((payload) => ({ data: JSON.stringify(payload) }));

	return [...frames.flatMap((frame) => decoder.push(frame)), ...decoder.flush()];
}

/** The text of every event of a given kind, joined. */
function textOf(events: readonly NeutralEvent[], kind: 'text' | 'thinking'): string {
	return events
		.filter((event) => event.kind === kind)
		.map((event) => (event as { text: string }).text)
		.join('');
}

describe('createSseParser', () => {
	test('splits a stream into events', () => {
		const parser = createSseParser();
		const events = parser.push(new TextEncoder().encode('data: one\n\ndata: two\n\n'));

		assert.deepEqual(events, [
			{ event: undefined, data: 'one' },
			{ event: undefined, data: 'two' },
		]);
	});

	test('joins several data lines of one event', () => {
		const parser = createSseParser();

		assert.deepEqual(parser.push(new TextEncoder().encode('data: one\ndata: two\n\n')), [
			{ event: undefined, data: 'one\ntwo' },
		]);
	});

	test('carries the event name', () => {
		const parser = createSseParser();

		assert.deepEqual(parser.push(new TextEncoder().encode('event: ping\ndata: {}\n\n')), [
			{ event: 'ping', data: '{}' },
		]);
	});

	test('ignores comments, which keep-alive pings use', () => {
		const parser = createSseParser();

		assert.deepEqual(parser.push(new TextEncoder().encode(': keep-alive\n\n')), []);
	});

	test('reassembles an event split across chunks', () => {
		const parser = createSseParser();
		const encoder = new TextEncoder();

		assert.deepEqual(parser.push(encoder.encode('da')), []);
		assert.deepEqual(parser.push(encoder.encode('ta: split\n')), []);
		assert.deepEqual(parser.push(encoder.encode('\n')), [{ event: undefined, data: 'split' }]);
	});

	test('accepts CRLF line endings', () => {
		const parser = createSseParser();

		assert.deepEqual(parser.push(new TextEncoder().encode('data: crlf\r\n\r\n')), [
			{ event: undefined, data: 'crlf' },
		]);
	});

	test('flushes an event that ends without its blank line', () => {
		const parser = createSseParser();
		parser.push(new TextEncoder().encode('data: tail\n'));

		assert.deepEqual(parser.end(), [{ event: undefined, data: 'tail' }]);
	});
});

describe('chatCompletions', () => {
	test('builds a streaming request with a bearer token', () => {
		const { url, headers, json } = request('chatCompletions');

		assert.equal(url, 'https://example.test/v1/chat/completions');
		assert.equal(headers.authorization, 'Bearer secret');
		assert.equal(json.model, 'model');
		assert.equal(json.stream, true);
		assert.equal(json.max_tokens, 1_000);
	});

	test('omits tool fields when no tools are offered', () => {
		const { json } = request('chatCompletions');

		assert.equal('tools' in json, false);
		assert.equal('tool_choice' in json, false);
	});

	test('offers tools with a matching choice', () => {
		const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }];

		assert.equal(request('chatCompletions', { tools }).json.tool_choice, 'auto');
		assert.equal(
			request('chatCompletions', { tools, requireToolCall: true }).json.tool_choice,
			'required',
		);
	});

	test('maps an effort level and maps disabled onto none', () => {
		assert.equal(
			request('chatCompletions', { reasoning: { choice: 'high' } }).json.reasoning_effort,
			'high',
		);
		assert.equal(
			request('chatCompletions', { reasoning: { choice: 'disabled' } }).json.reasoning_effort,
			'none',
		);
	});

	test('leaves the effort off the request when reasoning is left alone', () => {
		assert.equal(
			'reasoning_effort' in request('chatCompletions', { reasoning: { choice: 'enabled' } }).json,
			false,
		);
	});

	test('sends an image as a data URI', () => {
		const messages = [
			{
				role: 'user' as const,
				text: 'look',
				images: [{ data: new Uint8Array([1, 2]), mimeType: 'image/png' }],
				toolCalls: [],
				toolResults: [],
				reasoning: [],
			},
		];
		const { json } = request('chatCompletions', { messages });

		assert.deepEqual(json.messages[0].content, [
			{ type: 'text', text: 'look' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } },
		]);
	});

	test('expands tool results into their own turns', () => {
		const messages = [
			{
				role: 'assistant' as const,
				text: '',
				images: [],
				toolCalls: [{ callId: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
				toolResults: [{ callId: 'call_1', text: 'contents', images: [] }],
				reasoning: [],
			},
		];
		const { json } = request('chatCompletions', { messages });

		assert.deepEqual(json.messages[0].tool_calls, [
			{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
		]);
		assert.deepEqual(json.messages[1], {
			role: 'tool',
			tool_call_id: 'call_1',
			content: 'contents',
		});
	});

	test('decodes text, reasoning and usage', () => {
		const events = decode('chatCompletions', [
			{ choices: [{ delta: { content: 'hello' } }] },
			{ choices: [{ delta: { reasoning_content: 'thinking' } }] },
			{ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
		]);

		assert.equal(textOf(events, 'text'), 'hello');
		assert.equal(textOf(events, 'thinking'), 'thinking');
		assert.deepEqual(events.at(-1), { kind: 'usage', inputTokens: 7, outputTokens: 3 });
	});

	test('assembles a tool call split across fragments', () => {
		const events = decode('chatCompletions', [
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read' } }] } },
				],
			},
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] },
		]);

		assert.deepEqual(events, [
			{ kind: 'toolCall', callId: 'call_1', name: 'read', arguments: '{"path":"a"}' },
		]);
	});

	test('gives a tool with no arguments an empty object', () => {
		const events = decode('chatCompletions', [
			{
				choices: [
					{
						delta: {
							tool_calls: [{ index: 0, id: 'c', function: { name: 'ping', arguments: '' } }],
						},
					},
				],
			},
		]);

		assert.deepEqual(events, [{ kind: 'toolCall', callId: 'c', name: 'ping', arguments: '{}' }]);
	});

	test('ignores the end-of-stream marker', () => {
		const decoder = adapterFor('chatCompletions').startStream();

		assert.deepEqual(decoder.push({ data: '[DONE]' }), []);
	});
});

describe('messages', () => {
	test('authenticates with an api key header and pins the api version', () => {
		const { url, headers, json } = request('messages');

		assert.equal(url, 'https://example.test/v1/messages');
		assert.equal(headers['x-api-key'], 'secret');
		assert.equal(headers['anthropic-version'], '2023-06-01');
		assert.equal(json.max_tokens, 1_000);
	});

	test('merges consecutive turns of one role', () => {
		const messages = [
			{
				role: 'user' as const,
				text: 'one',
				images: [],
				toolCalls: [],
				toolResults: [],
				reasoning: [],
			},
			{
				role: 'user' as const,
				text: 'two',
				images: [],
				toolCalls: [],
				toolResults: [],
				reasoning: [],
			},
		];
		const { json } = request('messages', { messages });

		assert.equal(json.messages.length, 1);
		assert.deepEqual(json.messages[0].content, [
			{ type: 'text', text: 'one' },
			{ type: 'text', text: 'two' },
		]);
	});

	test('places tool results in a user turn after the call', () => {
		const messages = [
			{
				role: 'assistant' as const,
				text: '',
				images: [],
				toolCalls: [{ callId: 'toolu_1', name: 'read', arguments: '{"path":"a"}' }],
				toolResults: [{ callId: 'toolu_1', text: 'contents', images: [] }],
				reasoning: [],
			},
		];
		const { json } = request('messages', { messages });

		assert.deepEqual(json.messages[0], {
			role: 'assistant',
			content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a' } }],
		});
		assert.deepEqual(json.messages[1], {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents' }],
		});
	});

	test('turns an effort level into a token budget', () => {
		const { json } = request('messages', {
			reasoning: { choice: 'high' },
			maxOutputTokens: 100_000,
		});

		assert.deepEqual(json.thinking, { type: 'enabled', budget_tokens: 16_384 });
	});

	test('clamps a budget to the model bounds and the output cap', () => {
		const { json } = request('messages', {
			reasoning: { choice: 'max', budget: { min: 1_024, max: 5_000 } },
			maxOutputTokens: 5_000,
		});

		assert.deepEqual(json.thinking, { type: 'enabled', budget_tokens: 4_999 });
	});

	test('omits thinking when no budget can fit', () => {
		const { json } = request('messages', { reasoning: { choice: 'high' }, maxOutputTokens: 1_024 });

		assert.equal('thinking' in json, false);
	});

	test('disables thinking on request', () => {
		assert.deepEqual(request('messages', { reasoning: { choice: 'disabled' } }).json.thinking, {
			type: 'disabled',
		});
	});

	test('decodes text, thinking, a tool call and usage', () => {
		const events = decode('messages', [
			{ type: 'message_start', message: { usage: { input_tokens: 9 } } },
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
			{
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' },
			},
			{
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'input_json_delta', partial_json: '{"a"' },
			},
			{
				type: 'content_block_delta',
				index: 1,
				delta: { type: 'input_json_delta', partial_json: ':1}' },
			},
			{ type: 'content_block_start', index: 2, content_block: { type: 'text' } },
			{ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'done' } },
			{ type: 'message_delta', usage: { output_tokens: 4 } },
		]);

		assert.equal(textOf(events, 'thinking'), 'hmm');
		assert.equal(textOf(events, 'text'), 'done');
		assert.deepEqual(
			events.find((event) => event.kind === 'toolCall'),
			{
				kind: 'toolCall',
				callId: 'toolu_1',
				name: 'read',
				arguments: '{"a":1}',
			},
		);
		assert.deepEqual(events.at(-1), { kind: 'usage', inputTokens: 9, outputTokens: 4 });
	});

	test('replays a signed thinking block ahead of the reply', () => {
		const messages = [
			{
				role: 'assistant' as const,
				text: 'answer',
				images: [],
				toolCalls: [],
				toolResults: [],
				reasoning: [{ text: 'weighing', signature: 'sig' }],
			},
		];
		const { json } = request('messages', { messages });

		assert.deepEqual(json.messages[0].content, [
			{ type: 'thinking', thinking: 'weighing', signature: 'sig' },
			{ type: 'text', text: 'answer' },
		]);
	});

	test('replays a withheld thinking block in place of its text', () => {
		const messages = [
			{
				role: 'assistant' as const,
				text: '',
				images: [],
				toolCalls: [],
				toolResults: [],
				reasoning: [{ text: '', redacted: 'opaque' }],
			},
		];
		const { json } = request('messages', { messages });

		assert.deepEqual(json.messages[0].content, [{ type: 'redacted_thinking', data: 'opaque' }]);
	});

	test('reports a signed thinking block so the next turn can replay it', () => {
		const events = decode('messages', [
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
			{
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'weigh' },
			},
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ing' } },
			{
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'signature_delta', signature: 'sig' },
			},
			{ type: 'content_block_stop', index: 0 },
		]);

		assert.equal(textOf(events, 'thinking'), 'weighing');
		assert.deepEqual(
			events.filter((event) => event.kind === 'thinkingState'),
			[{ kind: 'thinkingState', text: 'weighing', signature: 'sig' }],
		);
	});

	test('leaves an unsigned thinking block out of the state', () => {
		const events = decode('messages', [
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
			{
				type: 'content_block_delta',
				index: 0,
				delta: { type: 'thinking_delta', thinking: 'guess' },
			},
			{ type: 'content_block_stop', index: 0 },
		]);

		assert.equal(
			events.some((event) => event.kind === 'thinkingState'),
			false,
		);
	});
});

describe('responses', () => {
	test('builds a stateless streaming request', () => {
		const { url, headers, json } = request('responses');

		assert.equal(url, 'https://example.test/v1/responses');
		assert.equal(headers.authorization, 'Bearer secret');
		assert.equal(json.store, false);
		assert.equal(json.max_output_tokens, 1_000);
	});

	test('sends tool calls and results as their own items', () => {
		const messages = [
			{
				role: 'assistant' as const,
				text: 'sure',
				images: [],
				toolCalls: [{ callId: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
				toolResults: [{ callId: 'call_1', text: 'contents', images: [] }],
				reasoning: [],
			},
		];
		const { json } = request('responses', { messages });

		assert.deepEqual(json.input[0], {
			type: 'message',
			role: 'assistant',
			content: [{ type: 'output_text', text: 'sure' }],
		});
		assert.deepEqual(json.input[1], {
			type: 'function_call',
			call_id: 'call_1',
			name: 'read',
			arguments: '{"path":"a"}',
		});
		assert.deepEqual(json.input[2], {
			type: 'function_call_output',
			call_id: 'call_1',
			output: [{ type: 'input_text', text: 'contents' }],
		});
	});

	test('maps an effort level into a reasoning object', () => {
		assert.deepEqual(request('responses', { reasoning: { choice: 'low' } }).json.reasoning, {
			effort: 'low',
		});
		assert.deepEqual(request('responses', { reasoning: { choice: 'disabled' } }).json.reasoning, {
			effort: 'none',
		});
	});

	test('decodes text, a tool call and usage', () => {
		const events = decode('responses', [
			{ type: 'response.output_text.delta', delta: 'hello' },
			{
				type: 'response.output_item.added',
				item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read' },
			},
			{ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":"a"}' },
			{ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
		]);

		assert.equal(textOf(events, 'text'), 'hello');
		assert.deepEqual(
			events.find((event) => event.kind === 'toolCall'),
			{
				kind: 'toolCall',
				callId: 'call_1',
				name: 'read',
				arguments: '{"path":"a"}',
			},
		);
		assert.deepEqual(events.at(-1), { kind: 'usage', inputTokens: 5, outputTokens: 2 });
	});

	test('replays an encrypted reasoning item ahead of the reply', () => {
		const messages = [
			{
				role: 'assistant' as const,
				text: 'answer',
				images: [],
				toolCalls: [],
				toolResults: [],
				reasoning: [{ id: 'rs_1', text: 'considered', signature: 'opaque' }],
			},
		];
		const { json } = request('responses', { messages });

		assert.deepEqual(json.input[0], {
			type: 'reasoning',
			id: 'rs_1',
			encrypted_content: 'opaque',
			summary: [],
		});
		assert.equal(json.input[1].type, 'message');
	});

	test('reports an encrypted reasoning item for replay', () => {
		const events = decode('responses', [
			{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'considered ' },
			{ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'options' },
			{
				type: 'response.output_item.done',
				item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
			},
		]);

		assert.equal(textOf(events, 'thinking'), 'considered options');
		assert.deepEqual(
			events.filter((event) => event.kind === 'thinkingState'),
			[{ kind: 'thinkingState', id: 'rs_1', text: 'considered options', signature: 'opaque' }],
		);
	});

	test('leaves a reasoning item with nothing encrypted out of the state', () => {
		const events = decode('responses', [
			{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } },
		]);

		assert.deepEqual(events, []);
	});
});
