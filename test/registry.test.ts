import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import * as vscode from 'vscode';

import type { Catalog, CatalogProvider } from '#/catalog/types.ts';
import { VENDOR_ID } from '#/ids.ts';
import { ProviderRegistry } from '#/provider/registry.ts';

/** A catalog holding one provider that offers one model. */
function catalog(): Catalog {
	return { deepseek: provider() };
}

function provider(): CatalogProvider {
	return {
		id: 'deepseek',
		name: 'DeepSeek',
		npm: '@ai-sdk/openai-compatible',
		api: 'https://api.deepseek.test/v1',
		models: { chat: { id: 'chat', name: 'Chat', limit: { context: 1_000, output: 100 } } },
	};
}

/** Warnings the extension put on screen, read off the stub the test loader installed. */
function warnings(): string[] {
	return (vscode.window as unknown as { warnings: string[] }).warnings;
}

/**
 * A registry over the catalog the given reader returns, already registered with the host's stub.
 *
 * A reader rather than a catalog: a test that covers a refresh swaps the catalog under it.
 */
function registryFor(current: () => Catalog): ProviderRegistry {
	const registry = new ProviderRegistry(
		{ current: () => ({ catalog: current(), origin: 'snapshot' }) },
		silentLog(),
	);
	registry.register();

	return registry;
}

/** The models one group is offered, asked the way the host asks for them. */
function ask(providerId: string): vscode.LanguageModelChatInformation[] {
	const provider = (
		vscode.lm as unknown as { providers: Map<string, vscode.LanguageModelChatProvider> }
	).providers.get(VENDOR_ID);
	const listed = provider?.provideLanguageModelChatInformation(
		{
			silent: true,
			configuration: { provider: providerId, apiKey: 'key' },
		} as unknown as vscode.PrepareLanguageModelChatModelOptions,
		token(),
	);

	// The provider answers synchronously, so the result is an array rather than a promise.
	return (listed as vscode.LanguageModelChatInformation[] | undefined) ?? [];
}

/** A cancellation token the provider can ignore. */
function token(): vscode.CancellationToken {
	return {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: (): void => undefined }),
	};
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

describe('unknown provider slugs', () => {
	beforeEach(() => {
		warnings().length = 0;
	});

	test('warn once for a slug the catalog does not have', () => {
		const registry = registryFor(catalog);

		assert.deepEqual(ask('deepsek'), []);
		assert.equal(warnings().length, 1);
		assert.match(warnings()[0]!, /deepsek/);

		registry.dispose();
	});

	test('say nothing more the next time the same slug is resolved', () => {
		const registry = registryFor(catalog);

		ask('deepsek');
		ask('deepsek');

		assert.equal(warnings().length, 1);
		registry.dispose();
	});

	test('warn again for a different slug, so a second mistake is not swallowed', () => {
		const registry = registryFor(catalog);

		ask('deepsek');
		ask('opneai');

		assert.equal(warnings().length, 2);
		registry.dispose();
	});

	test('stay quiet across a refresh, which clears models but not what was reported', () => {
		const registry = registryFor(catalog);

		ask('deepsek');
		registry.invalidate();
		ask('deepsek');

		assert.equal(warnings().length, 1);
		registry.dispose();
	});

	test('warn again once a refresh the user asked for has happened', () => {
		const registry = registryFor(catalog);

		ask('deepsek');
		registry.invalidateAfterUserRefresh();
		ask('deepsek');

		assert.equal(warnings().length, 2);
		registry.dispose();
	});

	test('warn again for every unknown slug at once, not just the last one resolved', () => {
		const registry = registryFor(catalog);

		ask('deepsek');
		ask('opneai');
		registry.invalidateAfterUserRefresh();
		ask('deepsek');
		ask('opneai');

		assert.equal(warnings().length, 4);
		registry.dispose();
	});

	test('say nothing about a slug the user’s refresh fixed', () => {
		let loaded = catalog();
		const registry = registryFor(() => loaded);

		ask('deepsek');

		// The refreshed catalog now has it, which is the outcome the warning was asking for.
		loaded = { ...catalog(), deepsek: provider() };
		registry.invalidateAfterUserRefresh();
		ask('deepsek');

		assert.equal(warnings().length, 1);
		registry.dispose();
	});

	test('stay quiet for a slug the catalog does have', () => {
		const registry = registryFor(catalog);

		assert.equal(ask('deepseek').length, 1);
		assert.deepEqual(warnings(), []);

		registry.dispose();
	});
});
