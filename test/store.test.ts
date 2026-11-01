import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { describe, test } from 'node:test';

import type { CatalogStoreOptions } from '#/catalog/store.ts';
import { CatalogStore } from '#/catalog/store.ts';

function payload(name: string): string {
	return JSON.stringify({
		example: {
			name,
			npm: '@ai-sdk/openai-compatible',
			api: 'https://example.test/v1',
			models: {},
		},
	});
}

const SNAPSHOT = payload('Snapshot');
const CACHED = payload('Cached');
const DOWNLOADED = payload('Downloaded');

interface Fixture extends CatalogStoreOptions {
	cleanup(): Promise<void>;
}

/** Lay out a temp directory holding a snapshot, and optionally a cache. */
async function createFixture(t: TestContext, cache?: string): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), 'models-dev-store-'));
	const snapshotPath = join(dir, 'snapshot.json');
	const cachePath = join(dir, 'cache', 'catalog.json');

	await writeFile(snapshotPath, SNAPSHOT);
	if (cache !== undefined) {
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(cachePath, cache);
	}

	const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
	t.after(cleanup);

	return { snapshotPath, cachePath, cleanup };
}

describe('CatalogStore', () => {
	test('loads the bundled snapshot when there is no cache', async (t) => {
		const store = new CatalogStore(await createFixture(t));

		const state = await store.load();

		assert.equal(state.origin, 'snapshot');
		assert.equal(state.catalog.example.name, 'Snapshot');
	});

	test('prefers a downloaded catalog over the snapshot', async (t) => {
		const store = new CatalogStore(await createFixture(t, CACHED));

		const state = await store.load();

		assert.equal(state.origin, 'cache');
		assert.equal(state.catalog.example.name, 'Cached');
	});

	test('falls back to the snapshot when the cache cannot be parsed', async (t) => {
		const store = new CatalogStore(await createFixture(t, '{ not json'));

		const state = await store.load();

		assert.equal(state.origin, 'snapshot');
		assert.equal(state.catalog.example.name, 'Snapshot');
	});

	test('notifies listeners of a load until they unsubscribe', async (t) => {
		const store = new CatalogStore(await createFixture(t));
		let changes = 0;
		const unsubscribe = store.onDidChange(() => changes++);

		await store.load();
		assert.equal(changes, 1);

		unsubscribe();
		await store.load();
		assert.equal(changes, 1);
	});

	test('refresh replaces the catalog and writes the cache', async (t) => {
		const fixture = await createFixture(t);
		const store = new CatalogStore(fixture);
		await store.load();

		t.mock.method(globalThis, 'fetch', async () => new Response(DOWNLOADED));
		const state = await store.refresh();

		assert.equal(state.origin, 'network');
		assert.equal(state.catalog.example.name, 'Downloaded');
		// The cache holds the parsed catalog rather than the raw response body.
		const cached: unknown = JSON.parse(await readFile(fixture.cachePath, 'utf8'));
		assert.deepEqual(cached, state.catalog);
	});

	test('a refreshed catalog is read back as the cache next time', async (t) => {
		const fixture = await createFixture(t);
		const store = new CatalogStore(fixture);
		await store.load();

		t.mock.method(globalThis, 'fetch', async () => new Response(DOWNLOADED));
		await store.refresh();

		const reloaded = await new CatalogStore(fixture).load();
		assert.equal(reloaded.origin, 'cache');
		assert.equal(reloaded.catalog.example.name, 'Downloaded');
	});

	test('leaves the catalog in place when a refresh fails', async (t) => {
		const store = new CatalogStore(await createFixture(t));
		await store.load();

		t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));

		await assert.rejects(() => store.refresh(), /503/);
		assert.equal(store.current()?.origin, 'snapshot');
		assert.equal(store.current()?.catalog.example.name, 'Snapshot');
	});
});
