import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { HARD_DISABLED_PROVIDERS, selectableProviders } from '#/catalog/providers.ts';
import type { Catalog, CatalogProvider } from '#/catalog/types.ts';
import { COMMANDS, PROVIDER_SETTING, VENDOR_ID } from '#/ids.ts';

const SNAPSHOT = new URL('../assets/catalog.snapshot.json', import.meta.url);

interface Property {
	readonly type?: string;
	readonly secret?: boolean;
	readonly title?: string;
}

interface Contribution {
	readonly vendor: string;
	readonly displayName: string;
	readonly managementCommand?: string;
	readonly configuration?: {
		readonly required?: readonly string[];
		readonly properties?: Record<string, Property>;
	};
}

interface Manifest {
	readonly activationEvents?: string[];
	readonly contributes?: {
		readonly languageModelChatProviders?: readonly Contribution[];
		readonly commands?: readonly { readonly command: string }[];
		readonly configuration?: { readonly properties?: Record<string, unknown> };
	};
}

async function manifest(): Promise<Manifest> {
	return JSON.parse(
		await readFile(new URL('../package.json', import.meta.url), 'utf8'),
	) as Manifest;
}

async function snapshot(): Promise<Catalog> {
	return JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Catalog;
}

function vendors(loaded: Manifest): readonly Contribution[] {
	return loaded.contributes?.languageModelChatProviders ?? [];
}

describe('manifest', () => {
	test('registers the one vendor the extension serves', async () => {
		const declared = vendors(await manifest());

		assert.deepEqual(
			declared.map((entry) => entry.vendor),
			[VENDOR_ID],
		);
		assert.equal(declared[0]?.displayName, 'Models.dev');
	});

	test('asks the host for a secret API key and a plain provider choice', async () => {
		const properties = vendors(await manifest())[0]?.configuration?.properties ?? {};

		assert.equal(properties['apiKey']?.secret, true);
		assert.equal(properties[PROVIDER_SETTING]?.secret, undefined);
		assert.notEqual(properties['baseUrl'], undefined);
	});

	test('requires the provider and the key, so the host wizard cannot store half a group', async () => {
		assert.deepEqual(vendors(await manifest())[0]?.configuration?.required, [
			PROVIDER_SETTING,
			'apiKey',
		]);
	});

	test('names a declared command as the vendor’s management command', async () => {
		const loaded = await manifest();
		const managementCommand = vendors(loaded)[0]?.managementCommand;

		assert.equal(managementCommand, COMMANDS.addProvider);

		const declared = (loaded.contributes?.commands ?? []).map((entry) => entry.command);
		for (const command of Object.values(COMMANDS)) {
			assert.equal(declared.includes(command), true, command);
		}
	});

	test('contributes no settings, so Add Provider is the only control point', async () => {
		assert.equal((await manifest()).contributes?.configuration, undefined);
	});

	test('activates at startup, so the picker is populated early', async () => {
		assert.deepEqual((await manifest()).activationEvents, ['onStartupFinished']);
	});
});

describe('snapshot', () => {
	test('holds exactly the providers the extension can serve', async () => {
		const catalog = await snapshot();

		assert.deepEqual(
			Object.keys(catalog).sort(),
			selectableProviders(catalog)
				.map((provider) => provider.id)
				.sort(),
		);
	});

	test('leaves out the providers VS Code serves itself', async () => {
		const catalog = await snapshot();

		for (const id of HARD_DISABLED_PROVIDERS) {
			assert.equal(catalog[id], undefined, id);
		}
	});
});

describe('selectableProviders', () => {
	test('leaves out a provider the host serves itself, even when it has models', () => {
		const catalog: Catalog = { openai: provider('OpenAI', { 'gpt-5': model() }) };

		assert.deepEqual(selectableProviders(catalog), []);
	});

	test('leaves out a provider whose every model is unservable', () => {
		const catalog: Catalog = {
			exotic: provider('Exotic', { thing: model() }, '@ai-sdk/amazon-bedrock'),
		};

		assert.deepEqual(selectableProviders(catalog), []);
	});

	test('counts the servable models and orders providers by name', () => {
		const catalog: Catalog = {
			zeta: provider('Zeta', { a: model(), b: model() }),
			alpha: provider('Alpha', { c: model() }),
		};

		assert.deepEqual(selectableProviders(catalog), [
			{ id: 'alpha', name: 'Alpha', modelCount: 1, needsBaseUrl: false },
			{ id: 'zeta', name: 'Zeta', modelCount: 2, needsBaseUrl: false },
		]);
	});

	test('flags a template endpoint, which only works once the user fills it in', () => {
		const catalog: Catalog = {
			templated: provider('Templated', { a: model() }, undefined, 'https://${HOST}/v1'),
		};

		assert.equal(selectableProviders(catalog)[0]?.needsBaseUrl, true);
	});
});

function provider(
	name: string,
	models: CatalogProvider['models'],
	npm: string = '@ai-sdk/openai-compatible',
	api: string = 'https://catalog.test/v1',
): CatalogProvider {
	return { id: name.toLowerCase(), name, npm, api, models };
}

function model(): CatalogProvider['models'][string] {
	return { id: 'model', name: 'Model', limit: { context: 1_000, output: 100 } };
}
