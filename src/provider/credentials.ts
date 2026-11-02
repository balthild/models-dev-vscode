/**
 * What the user supplied for one provider, once they have added it.
 *
 * Kept free of `vscode` so the decision can be tested: whether a provider is usable is the
 * difference between listing its models and staying in the Add Provider menu.
 */
export interface Credentials {
	readonly apiKey: string;
	/** Endpoint override, for someone reaching a provider through a gateway. */
	readonly baseUrl?: string;
}

/**
 * Read credentials out of the configuration the host resolved for a provider.
 *
 * @returns `undefined` when no key was supplied. The host only sends a configuration for a provider
 *   the user has added, which is what separates "configured" from "still in the menu".
 */
export function credentialsOf(configuration: unknown): Credentials | undefined {
	const settings = isRecord(configuration) ? configuration : {};

	const apiKey = readSetting(settings, 'apiKey');
	if (apiKey === undefined) {
		return undefined;
	}

	const baseUrl = readSetting(settings, 'baseUrl');

	// Trimmed because a pasted key picks up surrounding whitespace, which the provider would send
	// as part of the credential.
	return baseUrl === undefined ? { apiKey: apiKey.trim() } : { apiKey: apiKey.trim(), baseUrl };
}

/** Read a non-empty string out of the host-resolved configuration. */
export function readSetting(
	configuration: Readonly<Record<string, unknown>>,
	key: string,
): string | undefined {
	const value = configuration[key];

	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
