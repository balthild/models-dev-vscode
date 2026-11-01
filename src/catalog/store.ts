import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseCatalog } from './project.ts';
import { fetchCatalog, readSnapshot } from './source.ts';
import type { Catalog } from './types.ts';

/** Where the catalog in use came from. */
export type CatalogOrigin = 'snapshot' | 'cache' | 'network';

export interface CatalogState {
	readonly catalog: Catalog;
	readonly origin: CatalogOrigin;
	/** When the download this catalog came from finished, if it came from one. */
	readonly fetchedAt?: number;
}

export interface CatalogStoreOptions {
	/** Absolute path of the snapshot shipped with the extension. */
	readonly snapshotPath: string;
	/** Absolute path of the downloaded catalog cache. */
	readonly cachePath: string;
}

/**
 * Holds the catalog in use and decides where it came from.
 *
 * A downloaded catalog outranks the bundled snapshot because it is newer. The snapshot only matters
 * before the first successful download, or when there is no network at all, which is the case it
 * exists for.
 */
export class CatalogStore {
	private readonly options: CatalogStoreOptions;
	private state: CatalogState | undefined;
	private readonly listeners = new Set<() => void>();

	constructor(options: CatalogStoreOptions) {
		this.options = options;
	}

	/** The catalog in use, or `undefined` until {@link load} has run. */
	current(): CatalogState | undefined {
		return this.state;
	}

	/** Subscribe to catalog changes, which happen on load and on refresh. */
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);

		return () => this.listeners.delete(listener);
	}

	/**
	 * Populate the store from the cache, falling back to the bundled snapshot. Makes no network
	 * request.
	 *
	 * @throws When neither is readable. The snapshot ships with the extension, so that means a broken
	 *   installation rather than an offline machine.
	 */
	async load(): Promise<CatalogState> {
		const cached = await this.readCache();
		if (cached !== undefined) {
			return this.publish({
				catalog: cached.catalog,
				origin: 'cache',
				fetchedAt: cached.fetchedAt,
			});
		}

		return this.publish({
			catalog: await readSnapshot(this.options.snapshotPath),
			origin: 'snapshot',
		});
	}

	/**
	 * Replace the catalog with a freshly downloaded one.
	 *
	 * @throws When the download or parse fails. The catalog in use is left alone, so a failed refresh
	 *   never takes models away.
	 */
	async refresh(signal?: AbortSignal): Promise<CatalogState> {
		const catalog = await fetchCatalog(signal);
		await this.writeCache(catalog);

		return this.publish({ catalog, origin: 'network', fetchedAt: Date.now() });
	}

	private publish(state: CatalogState): CatalogState {
		this.state = state;
		for (const listener of this.listeners) {
			listener();
		}

		return state;
	}

	private async readCache(): Promise<{ catalog: Catalog; fetchedAt: number } | undefined> {
		try {
			const info = await stat(this.options.cachePath);

			return {
				catalog: parseCatalog(await readFile(this.options.cachePath, 'utf8')),
				fetchedAt: info.mtimeMs,
			};
		} catch {
			// A missing or unreadable cache is expected, not an error: the bundled
			// snapshot covers it, and the next refresh rewrites it.
			return undefined;
		}
	}

	private async writeCache(catalog: Catalog): Promise<void> {
		try {
			await mkdir(dirname(this.options.cachePath), { recursive: true });
			await writeFile(this.options.cachePath, JSON.stringify(catalog));
		} catch {
			// Caching is an optimisation. Losing it costs one download next start,
			// which does not justify failing a refresh that already succeeded.
		}
	}
}
