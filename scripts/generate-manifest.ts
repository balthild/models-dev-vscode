/**
 * Writes the generated parts of `package.json`: the provider contribution, the commands and the
 * activation event.
 *
 * Run with `yarn manifest`. VS Code reads vendor ids from the static manifest, so the vendor a
 * provider is registered under can only come from here; what it serves is decided at runtime, which
 * is what lets a provider models.dev adds later be usable without a release.
 *
 * `--check` reports whether the manifest is current instead of writing it, which is what CI uses.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { COMMANDS, PROVIDER_SETTING, VENDOR_ID, VENDOR_NAME } from '#/ids.ts';

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

const COMMAND_CATEGORY = 'Models.dev';

main().catch((error: unknown) => {
	console.error(`manifest: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const check = process.argv.includes('--check');
	const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8')) as Record<string, unknown>;

	pkg['activationEvents'] = ['onStartupFinished'];
	pkg['contributes'] = {
		languageModelChatProviders: [contribution()],
		commands: [
			{
				command: COMMANDS.addProvider,
				title: 'Add Provider',
				category: COMMAND_CATEGORY,
			},
			{
				command: COMMANDS.updateData,
				title: 'Update Model Data',
				category: COMMAND_CATEGORY,
			},
			{
				command: COMMANDS.showStatus,
				title: 'Show Model Data Status',
				category: COMMAND_CATEGORY,
			},
		],
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
	console.log(`manifest: ${VENDOR_NAME} written to package.json`);
}

function contribution(): Record<string, unknown> {
	return {
		vendor: VENDOR_ID,
		displayName: VENDOR_NAME,
		// The host hands Add Models for this vendor to the provider instead of running its own
		// wizard, which is the only way a group can ask for something a schema cannot offer.
		managementCommand: COMMANDS.addProvider,
		// Still declared, so the host's own wizard remains a way in if the management command is
		// ever dropped.
		configuration: {
			type: 'object',
			required: [PROVIDER_SETTING, 'apiKey'],
			properties: {
				[PROVIDER_SETTING]: {
					type: 'string',
					title: 'Provider',
					description: `models.dev provider id, such as deepseek or commandcode. See https://models.dev.`,
				},
				apiKey: {
					type: 'string',
					title: 'API Key',
					secret: true,
					description: `API key for the provider. Stored in VS Code's secret storage.`,
				},
				baseUrl: {
					type: 'string',
					title: 'Base URL',
					description: `Endpoint to use instead of the one models.dev publishes. Leave empty for the default.`,
				},
			},
		},
	};
}
