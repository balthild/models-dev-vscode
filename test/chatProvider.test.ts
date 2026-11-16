import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';
import { CatalogChatProvider } from '#/provider/chatProvider.ts';

const VENDOR = 'example';
const PROVIDER_ID = 'example-provider';

const MODEL: NeutralModel = {
	id: 'example-model',
	name: 'Example Model',
	description: 'A model',
	family: 'example',
	version: '2026-01-01',
	api: 'openai-completions',
	baseUrl: 'https://catalog.test/v1',
	contextWindow: 100_000,
	maxInputTokens: 90_000,
	maxOutputTokens: 10_000,
	imageInput: false,
	toolCalling: true,
	reasoning: {
		supported: true,
		efforts: ['low', 'medium', 'high'],
		canDisable: true,
		always: false,
		defaultChoice: 'medium',
	},
};

/** One request the provider library made, reduced to what these tests are about. */
interface SentRequest {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly body: Record<string, unknown>;
}

interface Interception {
	readonly sent: SentRequest[];
	readonly restore: () => void;
}

/**
 * Answer every request with the stream given, defaulting to the smallest one the chat completions
 * protocol accepts.
 *
 * The point of going through the real library is that it builds the request: the URL comes from the
 * model's base URL and the credential from the options, so observing the request is observing the
 * decision under test rather than a copy of it.
 */
function interceptRequests(stream: string = STREAM): Interception {
	const sent: SentRequest[] = [];
	const original = globalThis.fetch;

	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		sent.push({
			url: request.url,
			authorization: request.headers.get('authorization') ?? undefined,
			body: JSON.parse(await request.text()) as Record<string, unknown>,
		});

		return new Response(stream, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		});
	}) as typeof globalThis.fetch;

	return { sent, restore: () => (globalThis.fetch = original) };
}

const STREAM = [
	chunk({ role: 'assistant', content: 'ok' }),
	'',
	`data: ${JSON.stringify({
		id: 'chunk',
		object: 'chat.completion.chunk',
		created: 0,
		model: MODEL.id,
		choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
		usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
	})}`,
	'',
	'data: [DONE]',
	'',
	'',
].join('\n');

/**
 * A stream that calls a tool, with the arguments split across deltas the way a provider sends them.
 *
 * This is the path the provider library rewrote in 1.5: streamed arguments used to be re-parsed
 * from their first byte on every delta, and now go into an incremental parser. What reaches the
 * host has to be the same either way — the complete text, parsed once.
 */
const TOOL_CALL_STREAM = [
	chunk({
		role: 'assistant',
		tool_calls: [
			{
				index: 0,
				id: 'call_1',
				type: 'function',
				function: { name: 'read_file', arguments: '{"pa' },
			},
		],
	}),
	'',
	chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"src' } }] }),
	'',
	chunk({ tool_calls: [{ index: 0, function: { arguments: '/main.ts"}' } }] }),
	'',
	chunk({}, 'tool_calls'),
	'',
	'data: [DONE]',
	'',
	'',
].join('\n');

/** One `chat.completion.chunk` carrying a delta. Events must be separated by a blank line. */
function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: 'chunk',
		object: 'chat.completion.chunk',
		created: 0,
		model: MODEL.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}`;
}

function provider(): CatalogChatProvider {
	return new CatalogChatProvider({
		vendor: VENDOR,
		models: (providerId) => (providerId === PROVIDER_ID ? [MODEL] : []),
		log: silentLog(),
	});
}

/** A log channel that keeps a test run quiet. */
function silentLog(): vscode.LogOutputChannel {
	const drop = (): void => undefined;

	return {
		trace: drop,
		debug: drop,
		info: drop,
		warn: drop,
		error: drop,
	} as unknown as vscode.LogOutputChannel;
}

/**
 * The options the host lists models with.
 *
 * `configuration` is declared in the proposed `chatProvider` API, which the published typings do
 * not include. The provider reads it defensively; these tests set it the same way.
 */
function listOptions(
	configuration?: Readonly<Record<string, unknown>>,
): vscode.PrepareLanguageModelChatModelOptions {
	return { silent: false, configuration } as unknown as vscode.PrepareLanguageModelChatModelOptions;
}

/** The options the host dispatches a request with; `modelConfiguration` is proposed as well. */
function askOptions(effort?: EffortChoice): vscode.ProvideLanguageModelChatResponseOptions {
	const modelConfiguration = effort === undefined ? {} : { reasoningEffort: effort };

	return {
		tools: [],
		modelConfiguration,
	} as unknown as vscode.ProvideLanguageModelChatResponseOptions;
}

/** A model object the provider never returned, as a host that had re-created one would pass it. */
function unlistedModel(): vscode.LanguageModelChatInformation {
	return { id: MODEL.id, name: MODEL.name } as unknown as vscode.LanguageModelChatInformation;
}

function token(): vscode.CancellationToken {
	return {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: (): void => undefined }),
	};
}

/** Ask for one completion, and return what the host was shown. */
async function ask(
	chat: CatalogChatProvider,
	model: vscode.LanguageModelChatInformation,
	effort?: EffortChoice,
): Promise<vscode.LanguageModelResponsePart[]> {
	const parts: vscode.LanguageModelResponsePart[] = [];

	await chat.provideLanguageModelChatResponse(
		model,
		[],
		askOptions(effort),
		{ report: (part) => parts.push(part) },
		token(),
	);

	return parts;
}

/** List the models one provider group offers. */
function list(
	chat: CatalogChatProvider,
	configuration?: Readonly<Record<string, unknown>>,
): vscode.LanguageModelChatInformation[] {
	return chat.provideLanguageModelChatInformation(listOptions(configuration));
}

/** The configuration the host resolves for a group the user added. */
function group(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return { provider: PROVIDER_ID, apiKey: 'key', ...overrides };
}

describe('CatalogChatProvider', () => {
	test('lists nothing for a group that names no provider or holds no key', () => {
		const chat = provider();

		// The call the host makes first, for the models that belong to no group.
		assert.deepEqual(list(chat), []);
		assert.deepEqual(list(chat, {}), []);
		assert.deepEqual(list(chat, { apiKey: 'key' }), []);
		assert.deepEqual(list(chat, { provider: PROVIDER_ID }), []);
		assert.deepEqual(list(chat, { provider: PROVIDER_ID, apiKey: '   ' }), []);
		// A provider that is not in the catalog has no models to offer.
		assert.deepEqual(list(chat, { provider: 'unknown', apiKey: 'key' }), []);
		assert.equal(list(chat, group()).length, 1);
	});

	test('keys each group’s request with that group’s credentials', async () => {
		const chat = provider();
		const { sent, restore } = interceptRequests();

		try {
			const first = list(chat, group({ apiKey: 'key-one', baseUrl: 'https://one.test/v1' }));
			const second = list(chat, group({ apiKey: 'key-two', baseUrl: 'https://two.test/v1' }));

			// Dispatched out of listing order on purpose: what decides the credentials is the model
			// object the host hands back, not the order the groups were resolved in.
			await ask(chat, second[0]!);
			await ask(chat, first[0]!);
		} finally {
			restore();
		}

		assert.deepEqual(
			sent.map((request) => request.url),
			['https://two.test/v1/chat/completions', 'https://one.test/v1/chat/completions'],
		);
		assert.deepEqual(
			sent.map((request) => request.authorization),
			['Bearer key-two', 'Bearer key-one'],
		);
	});

	test('refuses a model object it never listed, rather than guessing a key', async () => {
		const chat = provider();
		const { sent, restore } = interceptRequests();

		try {
			list(chat, group({ apiKey: 'key-one', baseUrl: 'https://one.test/v1' }));
			list(chat, group({ apiKey: 'key-two', baseUrl: 'https://two.test/v1' }));

			// Another group's credentials would go to whatever endpoint this model names.
			await assert.rejects(() => ask(chat, unlistedModel()));
		} finally {
			restore();
		}

		assert.deepEqual(sent, []);
	});

	test('carries the picked reasoning effort onto the request', async () => {
		const chat = provider();
		const { sent, restore } = interceptRequests();

		try {
			const models = list(chat, group({ baseUrl: 'https://one.test/v1' }));

			await ask(chat, models[0]!, 'high');
		} finally {
			restore();
		}

		assert.equal(sent[0]?.body['reasoning_effort'], 'high');
	});

	test('reports usage the host can size the context window from', async () => {
		const chat = provider();
		const { restore } = interceptRequests();

		let parts: vscode.LanguageModelResponsePart[];
		try {
			parts = await ask(chat, list(chat, group({ baseUrl: 'https://one.test/v1' }))[0]!);
		} finally {
			restore();
		}

		const usage = parts.filter(
			(part): part is vscode.LanguageModelDataPart =>
				part instanceof vscode.LanguageModelDataPart && part.mimeType === 'usage',
		);

		assert.equal(usage.length, 1, 'exactly one usage part should be reported');
		// Without `total_tokens` the whole part is dropped and the window reads 0%.
		assert.deepEqual(JSON.parse(new TextDecoder().decode(usage[0]!.data)), {
			prompt_tokens: 3,
			completion_tokens: 1,
			total_tokens: 4,
			prompt_tokens_details: { cached_tokens: 0 },
		});
	});

	test('reports a streamed tool call with its arguments whole', async () => {
		const chat = provider();
		const { restore } = interceptRequests(TOOL_CALL_STREAM);

		let parts: vscode.LanguageModelResponsePart[];
		try {
			parts = await ask(chat, list(chat, group({ baseUrl: 'https://one.test/v1' }))[0]!);
		} finally {
			restore();
		}

		const call = parts.find(
			(part): part is vscode.LanguageModelToolCallPart =>
				part instanceof vscode.LanguageModelToolCallPart,
		);

		assert.ok(call !== undefined, 'the tool call should have been reported to the host');
		assert.equal(call.callId, 'call_1');
		assert.equal(call.name, 'read_file');
		// Parsed, not the raw text: the host validates the input against the tool's schema.
		assert.deepEqual(call.input, { path: 'src/main.ts' });
	});
});
