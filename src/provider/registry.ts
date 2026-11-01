import * as vscode from 'vscode';

import type { NeutralModel } from '../catalog/derive.ts';
import { deriveProviderModels } from '../catalog/derive.ts';
import { SHIPPED_PROVIDERS } from '../catalog/providers.ts';
import type { CatalogStore } from '../catalog/store.ts';
import { CatalogChatProvider } from './chatProvider.ts';

/**
 * Owns one chat provider per shipped vendor.
 *
 * Vendors cannot appear at runtime — the host reads them from the static manifest — so every
 * shipped provider is registered up front, and the setting only decides which of them report any
 * models.
 */
export class ProviderRegistry implements vscode.Disposable {
	private readonly store: CatalogStore;
	private readonly log: vscode.LogOutputChannel;
	private readonly providers = new Map<string, CatalogChatProvider>();
	private readonly registrations: vscode.Disposable[] = [];
	private readonly cache = new Map<string, readonly NeutralModel[]>();
	private enabled: readonly string[] = [];

	constructor(store: CatalogStore, log: vscode.LogOutputChannel) {
		this.store = store;
		this.log = log;
	}

	/** Register every shipped vendor with the host. Call once, during activation. */
	register(): void {
		for (const { id } of SHIPPED_PROVIDERS) {
			const provider = new CatalogChatProvider({
				vendor: id,
				models: () => this.modelsFor(id),
				log: this.log,
			});

			this.providers.set(id, provider);
			this.registrations.push(vscode.lm.registerLanguageModelChatProvider(id, provider));
		}
	}

	/** Change which vendors report models, and tell the host. */
	setEnabled(ids: readonly string[]): void {
		this.enabled = ids;
		this.invalidate();
	}

	/** Discard derived models and tell the host to re-read them. */
	invalidate(): void {
		this.cache.clear();

		for (const provider of this.providers.values()) {
			provider.notifyModelsChanged();
		}
	}

	dispose(): void {
		for (const registration of this.registrations) {
			registration.dispose();
		}
		for (const provider of this.providers.values()) {
			provider.dispose();
		}
	}

	/**
	 * The models a vendor currently offers.
	 *
	 * Derived once per catalog and cached: the host asks for this far more often than the catalog
	 * changes.
	 */
	private modelsFor(id: string): readonly NeutralModel[] {
		const cached = this.cache.get(id);
		if (cached !== undefined) {
			return cached;
		}

		const catalogProvider = this.store.current()?.catalog[id];
		const models =
			this.enabled.includes(id) && catalogProvider !== undefined
				? deriveProviderModels(catalogProvider)
				: [];

		this.cache.set(id, models);

		return models;
	}
}
