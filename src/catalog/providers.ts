/**
 * Providers served by VS Code itself. Registering any of these would put a second entry with the
 * same name in Add Provider, so they are excluded unconditionally — a setting cannot turn them on.
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

export interface ShippedProvider {
	/** Models.dev provider id, which doubles as the VS Code vendor id. */
	readonly id: string;
	/** Whether a fresh install offers this provider without opting in. */
	readonly defaultEnabled: boolean;
}

/**
 * Providers compiled into `contributes.languageModelChatProviders`.
 *
 * VS Code reads vendor ids from the static manifest, so this list — not the live catalog — decides
 * what can appear in Add Provider. Membership is limited to providers the catalog gives a base URL
 * for, which in practice means the ones served over an OpenAI-compatible endpoint: models.dev omits
 * `api` for providers whose AI SDK package hard-codes it, and those cannot be reached from here.
 */
export const SHIPPED_PROVIDERS: readonly ShippedProvider[] = [
	// Enabled by default: the few a new install most plausibly already has a key
	// for. Everything below is one settings change away; the split exists only to
	// keep a first-run picker in the low hundreds of models instead of thousands.
	{ id: 'cline-pass', defaultEnabled: true },
	{ id: 'opencode-go', defaultEnabled: true },
	{ id: 'deepseek', defaultEnabled: true },
	{ id: 'moonshotai', defaultEnabled: true },
	{ id: 'zai', defaultEnabled: true },
	{ id: 'zhipuai', defaultEnabled: true },
	{ id: 'alibaba', defaultEnabled: true },
	{ id: 'minimax', defaultEnabled: true },

	// Available on opt-in.
	{ id: '302ai', defaultEnabled: false },
	{ id: 'ai21', defaultEnabled: false },
	{ id: 'alibaba-cn', defaultEnabled: false },
	{ id: 'arcee', defaultEnabled: false },
	{ id: 'cloudflare-workers-ai', defaultEnabled: false },
	{ id: 'databricks', defaultEnabled: false },
	{ id: 'digitalocean', defaultEnabled: false },
	{ id: 'fireworks-ai', defaultEnabled: false },
	{ id: 'huggingface', defaultEnabled: false },
	{ id: 'inception', defaultEnabled: false },
	{ id: 'kilo', defaultEnabled: false },
	{ id: 'morph', defaultEnabled: false },
	{ id: 'nebius', defaultEnabled: false },
	{ id: 'novita-ai', defaultEnabled: false },
	{ id: 'nvidia', defaultEnabled: false },
	{ id: 'opencode', defaultEnabled: false },
	{ id: 'poe', defaultEnabled: false },
	{ id: 'requesty', defaultEnabled: false },
	{ id: 'siliconflow', defaultEnabled: false },
	{ id: 'siliconflow-cn', defaultEnabled: false },
	{ id: 'snowflake-cortex', defaultEnabled: false },
	{ id: 'stepfun', defaultEnabled: false },
	{ id: 'upstage', defaultEnabled: false },
	{ id: 'wandb', defaultEnabled: false },
];

/** Providers a fresh install offers, in manifest order. */
export const DEFAULT_ENABLED_PROVIDERS: readonly string[] = SHIPPED_PROVIDERS.filter(
	(provider) => provider.defaultEnabled,
).map((provider) => provider.id);

/** Whether this extension ships a vendor for the given catalog provider. */
export function isShippedProvider(id: string): boolean {
	return SHIPPED_PROVIDERS.some((provider) => provider.id === id);
}
