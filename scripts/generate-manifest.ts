/**
 * Writes the generated parts of `package.json`: the provider contributions, the commands, the
 * settings and the activation event.
 *
 * Run with `yarn manifest`. VS Code reads vendor ids from the static manifest, so a provider can
 * only reach Add Provider if it is listed here; the list is generated rather than typed so it
 * cannot drift from {@link SHIPPED_PROVIDERS}.
 *
 * `--check` reports whether the manifest is current instead of writing it, which is what CI uses.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_ENABLED_PROVIDERS,
	HARD_DISABLED_PROVIDERS,
	SHIPPED_PROVIDERS,
} from '../src/catalog/providers.ts';
import type { Catalog } from '../src/catalog/types.ts';

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const SNAPSHOT_PATH = fileURLToPath(new URL('../assets/catalog.snapshot.json', import.meta.url));

const COMMAND_CATEGORY = 'Models.dev';

main().catch((error: unknown) => {
	console.error(`manifest: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const check = process.argv.includes('--check');
	const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8')) as Record<string, unknown>;
	const catalog = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')) as Catalog;

	const providers = SHIPPED_PROVIDERS.filter(({ id }) => !HARD_DISABLED_PROVIDERS.has(id));
	pkg['activationEvents'] = ['onStartupFinished'];
	pkg['contributes'] = {
		languageModelChatProviders: providers.map(({ id }) =>
			contribution(id, displayName(catalog, id)),
		),
		commands: [
			{
				command: 'modelsdev.updateData',
				title: 'Update Model Data',
				category: COMMAND_CATEGORY,
			},
			{
				command: 'modelsdev.showStatus',
				title: 'Show Model Data Status',
				category: COMMAND_CATEGORY,
			},
			{
				command: 'modelsdev.openSettings',
				title: 'Open Provider Settings',
				category: COMMAND_CATEGORY,
			},
		],
		configuration: {
			title: 'Models.dev',
			properties: {
				'modelsdev.providers': {
					type: 'array',
					items: { type: 'string' },
					default: DEFAULT_ENABLED_PROVIDERS,
					markdownDescription:
						'Providers to offer in the model picker. Providers VS Code already serves are always excluded.',
				},
			},
		},
	};

	const json = `${JSON.stringify(pkg, null, '\t')}\n`;

	if (check) {
		if ((await readFile(PACKAGE_PATH, 'utf8')) !== json) {
			console.error('manifest: package.json is out of date. Run `yarn manifest`.');
			process.exitCode = 1;
		}

		return;
	}

	await writeFile(PACKAGE_PATH, json);
	console.log(`manifest: ${providers.length} providers written to package.json`);
}

function contribution(vendor: string, displayName: string): Record<string, unknown> {
	return {
		vendor,
		displayName,
		configuration: {
			properties: {
				apiKey: {
					type: 'string',
					secret: true,
					description: `API key for ${displayName}. Stored in VS Code's secret storage.`,
				},
				baseUrl: {
					type: 'string',
					description: `Endpoint to use instead of the one models.dev publishes for ${displayName}. Leave empty for the default.`,
				},
			},
		},
	};
}

function displayName(catalog: Catalog, id: string): string {
	return catalog[id]?.name ?? id;
}
