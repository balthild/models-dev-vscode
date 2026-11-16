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
	/** Only reads the catalog, so that is all it asks the store for. */
	private readonly store: Pick<CatalogStore, 'current'>;
	private readonly log: vscode.LogOutputChannel;
	private provider: CatalogChatProvider | undefined;
	private registration: vscode.Disposable | undefined;
	private readonly cache = new Map<string, readonly NeutralModel[]>();
	/**
	 * Slugs already reported as unknown.
	 *
	 * Kept apart from {@link cache}, which every refresh clears: a group left unfixed would otherwise
	 * complain again each time the catalog downloads on its own.
	 */
	private readonly reportedUnknown = new Set<string>();

	constructor(store: Pick<CatalogStore, 'current'>, log: vscode.LogOutputChannel) {
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

	/**
	 * The same, for a refresh the user asked for.
	 *
	 * Such a refresh is also the moment a wrong provider id is worth pointing out again, so the
	 * record of what was reported goes with it.
	 */
	invalidateAfterUserRefresh(): void {
		this.reportedUnknown.clear();
		this.invalidate();
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
			this.reportUnknown(providerId);
			this.cache.set(providerId, []);

			return [];
		}

		const models = deriveProviderModels(provider);

		this.cache.set(providerId, models);

		return models;
	}

	/**
	 * Say that a group names a provider the catalog does not offer.
	 *
	 * Once per slug: the host resolves models on every change, so a group left unfixed would
	 * otherwise repeat the warning until it is removed. The catalog may also simply predate the
	 * provider, which is why the message names the fix rather than calling it a mistake.
	 */
	private reportUnknown(providerId: string): void {
		if (this.reportedUnknown.has(providerId)) {
			return;
		}

		this.reportedUnknown.add(providerId);
		this.log.warn(`A group names ${providerId}, which the catalog does not offer.`);

		void vscode.window.showWarningMessage(
			`Models.dev has no provider named "${providerId}". Check the id, or run Update Model Data if models.dev added it recently.`,
		);
	}
}
