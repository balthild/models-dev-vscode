import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import { deriveProviderModels } from '#/catalog/derive.ts';
import type { CatalogStore } from '#/catalog/store.ts';
import { VENDOR_ID } from '#/ids.ts';

import { CatalogChatProvider } from './chatProvider.ts';

/**
 * Serves the catalog to the host under the one vendor this extension registers.
 *
 * Vendors cannot appear at runtime — the host reads them from the static manifest — so a single
 * vendor is what lets a provider models.dev adds later be usable without a release: the group the
 * user creates names it.
 */
export class ProviderRegistry implements vscode.Disposable {
	private readonly store: CatalogStore;
	private readonly log: vscode.LogOutputChannel;
	private provider: CatalogChatProvider | undefined;
	private registration: vscode.Disposable | undefined;
	private readonly cache = new Map<string, readonly NeutralModel[]>();

	constructor(store: CatalogStore, log: vscode.LogOutputChannel) {
		this.store = store;
		this.log = log;
	}

	/** Register the vendor with the host. Call once, during activation. */
	register(): void {
		this.provider = new CatalogChatProvider({
			vendor: VENDOR_ID,
			models: (providerId) => this.modelsFor(providerId),
			log: this.log,
		});
		this.registration = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, this.provider);
	}

	/** Discard derived models and tell the host to re-read them. */
	invalidate(): void {
		this.cache.clear();
		this.provider?.notifyModelsChanged();
	}

	dispose(): void {
		this.registration?.dispose();
		this.provider?.dispose();
	}

	/**
	 * The models a catalog provider currently offers.
	 *
	 * Derived once per catalog and cached: the host asks for this far more often than the catalog
	 * changes.
	 */
	private modelsFor(providerId: string): readonly NeutralModel[] {
		const cached = this.cache.get(providerId);
		if (cached !== undefined) {
			return cached;
		}

		const provider = this.store.current()?.catalog[providerId];
		if (provider === undefined) {
			// A group whose provider was mistyped, or that the catalog dropped, lists nothing.
			this.log.warn(`A group names ${providerId}, which the catalog does not offer.`);
			this.cache.set(providerId, []);

			return [];
		}

		const models = deriveProviderModels(provider);

		this.cache.set(providerId, models);

		return models;
	}
}
