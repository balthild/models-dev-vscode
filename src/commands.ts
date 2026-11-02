import * as vscode from 'vscode';

import type { CatalogStore } from './catalog/store.ts';
import type { Catalog } from './catalog/types.ts';
import type { ProviderRegistry } from './provider/registry.ts';
import { messageOf } from './util/errors.ts';

export interface CommandContext {
	readonly store: CatalogStore;
	readonly registry: ProviderRegistry;
	readonly log: vscode.LogOutputChannel;
}

export function registerCommands(context: CommandContext): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('modelsdev.updateData', () => updateData(context)),
		vscode.commands.registerCommand('modelsdev.showStatus', () => showStatus(context)),
	];
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
				registry.invalidate();

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
