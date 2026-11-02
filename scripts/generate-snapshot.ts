/**
 * Regenerates `assets/catalog.snapshot.json` from the live models.dev catalog.
 *
 * Run with `yarn snapshot`. The snapshot is the fallback the extension ships, so a fresh install
 * with no network still offers models instead of an empty picker.
 *
 * Providers the extension does not ship, and the fields it never reads, are dropped: the snapshot
 * is deliberately smaller than what models.dev publishes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCatalog } from '#/catalog/project.ts';
import { HARD_DISABLED_PROVIDERS, SHIPPED_PROVIDERS } from '#/catalog/providers.ts';
import type { CatalogProvider } from '#/catalog/types.ts';

const CATALOG_URL = 'https://models.dev/api.json';
const OUTPUT = fileURLToPath(new URL('../assets/catalog.snapshot.json', import.meta.url));

main().catch((error: unknown) => {
	console.error(`snapshot: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const response = await fetch(CATALOG_URL);
	if (!response.ok) {
		throw new Error(`GET ${CATALOG_URL} failed with ${response.status}`);
	}

	const available = parseCatalog(await response.text());

	const providers: Record<string, CatalogProvider> = {};
	const missing: string[] = [];

	for (const id of SHIPPED_PROVIDERS) {
		if (HARD_DISABLED_PROVIDERS.has(id)) {
			continue;
		}

		const provider = available[id];
		if (provider === undefined) {
			missing.push(id);
			continue;
		}

		providers[id] = provider;
	}

	const json = JSON.stringify(providers);
	await mkdir(dirname(OUTPUT), { recursive: true });
	await writeFile(OUTPUT, json);

	const models = Object.values(providers).reduce(
		(total, provider) => total + Object.keys(provider.models).length,
		0,
	);
	console.log(
		`snapshot: ${Object.keys(providers).length} providers, ${models} models, ${(json.length / 1024).toFixed(0)} KiB`,
	);

	if (missing.length > 0) {
		console.log(`snapshot: not found in the catalog: ${missing.join(', ')}`);
	}
}
