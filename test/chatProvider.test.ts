import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';
import { CatalogChatProvider } from '#/provider/chatProvider.ts';

const VENDOR = 'example';

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
 * Answer every request with the smallest stream the chat completions protocol accepts.
 *
 * The point of going through the real library is that it builds the request: the URL comes from the
 * model's base URL and the credential from the options, so observing the request is observing the
 * decision under test rather than a copy of it.
 */
function interceptRequests(): Interception {
	const sent: SentRequest[] = [];
	const original = globalThis.fetch;

	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const request = new Request(input, init);
		sent.push({
			url: request.url,
			authorization: request.headers.get('authorization') ?? undefined,
			body: JSON.parse(await request.text()) as Record<string, unknown>,
		});

		return new Response(STREAM, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		});
	}) as typeof globalThis.fetch;

	return { sent, restore: () => (globalThis.fetch = original) };
}

const STREAM = [
	`data: ${JSON.stringify({
		id: 'chunk',
		object: 'chat.completion.chunk',
		created: 0,
		model: MODEL.id,
		choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
	})}`,
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

function provider(): CatalogChatProvider {
	return new CatalogChatProvider({ vendor: VENDOR, models: () => [MODEL], log: silentLog() });
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

describe('CatalogChatProvider', () => {
	test('lists nothing until a group has a key', () => {
		const chat = provider();

		// The call the host makes first, for the models that belong to no group.
		assert.deepEqual(list(chat), []);
		assert.deepEqual(list(chat, {}), []);
		assert.deepEqual(list(chat, { apiKey: '   ' }), []);
		assert.equal(list(chat, { apiKey: 'key' }).length, 1);
	});

	test('keys each group’s request with that group’s credentials', async () => {
		const chat = provider();
		const { sent, restore } = interceptRequests();

		try {
			const first = list(chat, { apiKey: 'key-one', baseUrl: 'https://one.test/v1' });
			const second = list(chat, { apiKey: 'key-two', baseUrl: 'https://two.test/v1' });

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

	test('falls back to the last listing for a model object it never returned', async () => {
		const chat = provider();
		const { sent, restore } = interceptRequests();

		try {
			list(chat, { apiKey: 'key-one', baseUrl: 'https://one.test/v1' });
			list(chat, { apiKey: 'key-two', baseUrl: 'https://two.test/v1' });

			await ask(chat, unlistedModel());
		} finally {
			restore();
		}

		assert.deepEqual(
			sent.map((request) => request.authorization),
			['Bearer key-two'],
		);
	});

	test('carries the picked reasoning effort onto the request', async () => {
		const chat = provider();
		const { sent, restore } = interceptRequests();

		try {
			const models = list(chat, { apiKey: 'key', baseUrl: 'https://one.test/v1' });

			await ask(chat, models[0]!, 'high');
		} finally {
			restore();
		}

		assert.equal(sent[0]?.body['reasoning_effort'], 'high');
	});
});
