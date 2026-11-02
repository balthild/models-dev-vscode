import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
	HARD_DISABLED_PROVIDERS,
	isShippedProvider,
	SHIPPED_PROVIDERS,
} from '#/catalog/providers.ts';
import type { Catalog } from '#/catalog/types.ts';

const SNAPSHOT = new URL('../assets/catalog.snapshot.json', import.meta.url);

/** The commands the extension registers, which the manifest has to declare. */
const COMMANDS = ['modelsdev.updateData', 'modelsdev.showStatus'];

interface Manifest {
	readonly activationEvents?: string[];
	readonly contributes?: {
		readonly languageModelChatProviders?: readonly {
			readonly vendor: string;
			readonly displayName: string;
			readonly configuration?: {
				readonly properties?: Record<string, { readonly secret?: boolean }>;
			};
		}[];
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

describe('shipped providers', () => {
	test('are listed once each', () => {
		assert.deepEqual([...new Set(SHIPPED_PROVIDERS)], SHIPPED_PROVIDERS);
	});

	test('never include a provider VS Code serves itself', () => {
		for (const id of SHIPPED_PROVIDERS) {
			assert.equal(HARD_DISABLED_PROVIDERS.has(id), false, id);
			assert.equal(isShippedProvider(id), true, id);
		}
	});
});

describe('snapshot', () => {
	test('covers every shipped provider', async () => {
		const catalog = await snapshot();

		for (const id of SHIPPED_PROVIDERS) {
			assert.notEqual(catalog[id], undefined, id);
		}
	});

	test('leaves out the providers VS Code serves itself', async () => {
		const catalog = await snapshot();

		for (const id of HARD_DISABLED_PROVIDERS) {
			assert.equal(catalog[id], undefined, id);
		}
	});
});

describe('manifest', () => {
	test('declares exactly the shipped providers as vendors', async () => {
		const declared = (await manifest()).contributes?.languageModelChatProviders ?? [];

		assert.deepEqual(declared.map((entry) => entry.vendor).sort(), [...SHIPPED_PROVIDERS].sort());
	});

	test('asks the host for a secret API key per vendor', async () => {
		const declared = (await manifest()).contributes?.languageModelChatProviders ?? [];

		for (const entry of declared) {
			assert.equal(entry.configuration?.properties?.apiKey?.secret, true, entry.vendor);
			assert.notEqual(entry.displayName, '', entry.vendor);
		}
	});

	test('declares every command the extension registers', async () => {
		const declared = ((await manifest()).contributes?.commands ?? []).map((entry) => entry.command);

		for (const command of COMMANDS) {
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
