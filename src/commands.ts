import * as vscode from 'vscode';

import type { SelectableProvider } from './catalog/providers.ts';
import { selectableProviders } from './catalog/providers.ts';
import type { CatalogStore } from './catalog/store.ts';
import type { Catalog } from './catalog/types.ts';
import { COMMANDS, PROVIDER_SETTING, VENDOR_ID } from './ids.ts';
import type { ProviderRegistry } from './provider/registry.ts';
import { messageOf } from './util/errors.ts';

/** How many numbered names to try before giving up on a vendor that already has each of them. */
const MAX_GROUP_ATTEMPTS = 10;

/** What the host says when a group of that name already exists for the vendor. */
const GROUP_EXISTS = /already exists/i;

export interface CommandContext {
	readonly store: CatalogStore;
	readonly registry: ProviderRegistry;
	readonly log: vscode.LogOutputChannel;
}

export function registerCommands(context: CommandContext): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(COMMANDS.updateData, () => updateData(context)),
		vscode.commands.registerCommand(COMMANDS.showStatus, () => showStatus(context)),
		vscode.commands.registerCommand(COMMANDS.addProvider, () => addProvider(context)),
	];
}

/**
 * Walk the user through adding one models.dev provider.
 *
 * Also reached without being asked: the manifest names this command as the vendor's management
 * command, and the host answers Add Models for such a vendor by calling the provider instead of
 * running its own wizard, so the provider starts this flow.
 */
async function addProvider({ store, log }: CommandContext): Promise<void> {
	const state = store.current();
	if (state === undefined) {
		void vscode.window.showWarningMessage('Model data has not loaded yet.');

		return;
	}

	const picked = await promptForProvider(state.catalog);
	if (picked === undefined) {
		return;
	}

	const apiKey = await vscode.window.showInputBox({
		title: `API key for ${picked.name}`,
		prompt: 'Stored in VS Code secret storage.',
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() === '' ? 'An API key is required.' : undefined),
	});
	if (apiKey === undefined) {
		return;
	}

	const baseUrl = await promptForBaseUrl(picked);
	if (baseUrl === undefined) {
		return;
	}

	try {
		await addGroup(picked.name, picked.id, apiKey.trim(), baseUrl.trim() || undefined);

		void vscode.window.showInformationMessage(
			`${picked.name} added. Pick its models from the model picker.`,
		);
	} catch (error) {
		log.error(`Could not add ${picked.id}: ${messageOf(error)}`);
		void vscode.window.showErrorMessage(`Could not add ${picked.name}: ${messageOf(error)}`);
	}
}

async function promptForProvider(catalog: Catalog): Promise<SelectableProvider | undefined> {
	const picked = await vscode.window.showQuickPick(
		selectableProviders(catalog).map((provider) => ({
			label: provider.name,
			description: provider.id,
			detail: `${provider.modelCount} models${provider.needsBaseUrl ? ', needs an endpoint' : ''}`,
			provider,
		})),
		{
			title: 'Add a models.dev provider',
			placeHolder: 'Search by name or id',
			matchOnDescription: true,
			ignoreFocusOut: true,
		},
	);

	return picked?.provider;
}

/**
 * Ask for the endpoint, requiring one when the catalog only publishes a template.
 *
 * @returns The answer, or `undefined` when the user cancelled. An empty answer means "use the
 *   endpoint models.dev publishes".
 */
async function promptForBaseUrl(provider: SelectableProvider): Promise<string | undefined> {
	return vscode.window.showInputBox({
		title: `Endpoint for ${provider.name}`,
		prompt: provider.needsBaseUrl
			? 'models.dev publishes a template for this provider, so the endpoint has to be filled in.'
			: 'Leave empty to use the endpoint models.dev publishes.',
		ignoreFocusOut: true,
		validateInput: provider.needsBaseUrl
			? (value) => (value.trim() === '' ? 'This provider needs an endpoint.' : undefined)
			: undefined,
	});
}

/**
 * Write the group, numbering the name if the vendor already has one.
 *
 * The host offers no way to read the groups already configured, so a taken name only shows up as a
 * rejection. Numbering is otherwise arbitrary: nothing in this extension reads the name back.
 */
async function addGroup(
	name: string,
	providerId: string,
	apiKey: string,
	baseUrl: string | undefined,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_GROUP_ATTEMPTS; attempt += 1) {
		try {
			await vscode.commands.executeCommand('lm.addLanguageModelsProviderGroup', {
				vendor: VENDOR_ID,
				name: attempt === 0 ? name : `${name} ${attempt + 1}`,
				[PROVIDER_SETTING]: providerId,
				apiKey,
				...(baseUrl === undefined ? {} : { baseUrl }),
			});

			return;
		} catch (error) {
			if (!GROUP_EXISTS.test(messageOf(error))) {
				throw error;
			}
		}
	}

	throw new Error(`Every name tried for ${name} is already in use.`);
}

/** Download the catalog and hand it to the providers, keeping the old one on failure. */
async function updateData({ store, registry, log }: CommandContext): Promise<void> {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Updating model data from models.dev',
		},
		async () => {
			try {
				const state = await store.refresh();
				// Asked for, so a group still naming an unknown provider gets pointed out again.
				registry.invalidateAfterUserRefresh();

				const summary = describe(state.catalog);
				log.info(`Catalog updated from models.dev: ${summary}`);
				void vscode.window.showInformationMessage(`Model data updated: ${summary}.`);
			} catch (error) {
				log.error(`Could not update model data: ${messageOf(error)}`);
				void vscode.window.showErrorMessage(`Could not update model data: ${messageOf(error)}`);
			}
		},
	);
}

/** Report which data is in use and how old it is. */
async function showStatus({ store }: CommandContext): Promise<void> {
	const state = store.current();
	if (state === undefined) {
		void vscode.window.showWarningMessage('Model data has not loaded.');

		return;
	}

	const age =
		state.fetchedAt === undefined
			? 'no download yet'
			: `downloaded ${describeAge(Date.now() - state.fetchedAt)}`;

	void vscode.window.showInformationMessage(
		`Model data: ${describe(state.catalog)}, from the ${state.origin} (${age}).`,
	);
}

function describe(catalog: Catalog): string {
	const providers = Object.keys(catalog).length;
	const models = Object.values(catalog).reduce(
		(total, provider) => total + Object.keys(provider.models).length,
		0,
	);

	return `${providers} providers, ${models} models`;
}

function describeAge(milliseconds: number): string {
	const minutes = Math.round(milliseconds / 60_000);
	if (minutes < 60) {
		return `${minutes} minutes ago`;
	}

	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} hours ago`;
	}

	return `${Math.round(hours / 24)} days ago`;
}
