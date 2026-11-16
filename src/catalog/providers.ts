import { deriveProviderModels } from './derive.ts';
import type { Catalog } from './types.ts';

/**
 * Providers served by VS Code itself. Serving any of these would put a second entry with the same
 * name in Add Provider, so they are left out of the picker unconditionally.
 */
export const HARD_DISABLED_PROVIDERS: ReadonlySet<string> = new Set([
	'anthropic',
	'azure',
	'azure-cognitive-services',
	'github-copilot',
	'google',
	'google-vertex',
	// VS Code's built-in Ollama provider covers the local server; the cloud
	// service is left out with it.
	'ollama-cloud',
	'openai',
	'openrouter',
	'xai',
]);

/** A catalog provider the extension can serve, in the shape the Add Provider picker needs. */
export interface SelectableProvider {
	readonly id: string;
	readonly name: string;
	readonly modelCount: number;
	/** Whether the published endpoint is a template, so serving it needs a URL from the user. */
	readonly needsBaseUrl: boolean;
}

/**
 * Every catalog provider the extension can serve, ordered by display name.
 *
 * Servable means the extension speaks the provider's protocol, the catalog gives a reachable
 * endpoint or one the user can fill in, and at least one model survives derivation. That is a
 * technical test only; the picker offers all of it, because the user decides which of these they
 * trust with a key.
 */
export function selectableProviders(catalog: Catalog): readonly SelectableProvider[] {
	const selectable: SelectableProvider[] = [];

	for (const [id, provider] of Object.entries(catalog)) {
		if (HARD_DISABLED_PROVIDERS.has(id)) {
			continue;
		}

		const models = deriveProviderModels(provider);
		if (models.length === 0) {
			continue;
		}

		selectable.push({
			id,
			name: provider.name,
			modelCount: models.length,
			needsBaseUrl: models.some((model) => model.baseUrl.includes('${')),
		});
	}

	return selectable.sort((left, right) => left.name.localeCompare(right.name));
}
