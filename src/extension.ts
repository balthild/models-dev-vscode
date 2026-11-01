import * as vscode from 'vscode';

import { CatalogStore } from './catalog/store.ts';
import { registerCommands } from './commands.ts';
import { enabledProviders, onDidChangeProviders } from './config/settings.ts';
import { ProviderRegistry } from './provider/registry.ts';
import { messageOf } from './util/errors.ts';

/** Download a newer catalog when the cached one is at least this old. */
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = vscode.window.createOutputChannel('Models.dev', { log: true });
	context.subscriptions.push(log);

	const store = new CatalogStore({
		snapshotPath: context.asAbsolutePath('assets/catalog.snapshot.json'),
		cachePath: vscode.Uri.joinPath(context.globalStorageUri, 'catalog.json').fsPath,
	});

	const registry = new ProviderRegistry(store, log);
	context.subscriptions.push(registry);

	// Load before registering so the picker is never briefly empty.
	try {
		const state = await store.load();
		log.info(
			`Catalog loaded from the ${state.origin}: ${Object.keys(state.catalog).length} providers.`,
		);
	} catch (error) {
		log.error(`Could not read the bundled catalog: ${messageOf(error)}`);
		void vscode.window.showErrorMessage(
			'Models.dev could not read its bundled model data. Reinstalling the extension should fix it.',
		);

		return;
	}

	registry.setEnabled(enabledProviders());
	registry.register();

	context.subscriptions.push(onDidChangeProviders(() => registry.setEnabled(enabledProviders())));
	context.subscriptions.push(new vscode.Disposable(store.onDidChange(() => registry.invalidate())));
	context.subscriptions.push(...registerCommands({ store, registry, log }));

	// Deliberately not awaited: activation should not block on the network.
	void refreshIfStale(store, log);
}

async function refreshIfStale(store: CatalogStore, log: vscode.LogOutputChannel): Promise<void> {
	const state = store.current();
	const isFresh =
		state?.origin === 'cache' &&
		state.fetchedAt !== undefined &&
		Date.now() - state.fetchedAt < MAX_CACHE_AGE_MS;

	if (isFresh) {
		return;
	}

	try {
		const next = await store.refresh();
		log.info(`Catalog refreshed: ${Object.keys(next.catalog).length} providers.`);
	} catch (error) {
		log.warn(`Could not refresh the catalog; keeping the current data. ${messageOf(error)}`);
	}
}
