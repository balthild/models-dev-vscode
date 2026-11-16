import { PROVIDER_SETTING } from '#/ids.ts';

/**
 * What the user supplied for one group, once they have added it.
 *
 * Kept free of `vscode` so the decision can be tested: whether a group is usable is the difference
 * between listing its models and staying out of the picker.
 */
export interface Credentials {
	/** The models.dev provider this group serves. */
	readonly provider: string;
	readonly apiKey: string;
	/** Endpoint override, for someone reaching a provider through a gateway. */
	readonly baseUrl?: string;
}

/**
 * Read credentials out of the configuration the host resolved for a group.
 *
 * @returns `undefined` when the group names no provider or supplies no key. The host only sends a
 *   configuration for a group the user has added, which is what separates "configured" from "still
 *   in the menu".
 */
export function credentialsOf(configuration: unknown): Credentials | undefined {
	const settings = isRecord(configuration) ? configuration : {};

	const provider = readSetting(settings, PROVIDER_SETTING);
	const apiKey = readSetting(settings, 'apiKey');
	if (provider === undefined || apiKey === undefined) {
		return undefined;
	}

	const baseUrl = readSetting(settings, 'baseUrl');

	// Trimmed because a pasted key picks up surrounding whitespace, which the provider would send
	// as part of the credential.
	return baseUrl === undefined
		? { provider: provider.trim(), apiKey: apiKey.trim() }
		: { provider: provider.trim(), apiKey: apiKey.trim(), baseUrl };
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
