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

/**
 * Providers compiled into `contributes.languageModelChatProviders`.
 *
 * VS Code reads vendor ids from the static manifest, so this list — not the live catalog — decides
 * what can appear in Add Provider. Membership is limited to providers the catalog gives a base URL
 * for, which in practice means the ones served over an OpenAI-compatible endpoint: models.dev omits
 * `api` for providers whose AI SDK package hard-codes it, and those cannot be reached from here.
 *
 * None of them serve models until the user adds one and supplies a key, which is deliberate:
 * listing a model that cannot be used reads as configured when it is not.
 */
export const SHIPPED_PROVIDERS: readonly string[] = [
	'302ai',
	'ai21',
	'alibaba',
	'alibaba-cn',
	'arcee',
	'cline-pass',
	'cloudflare-workers-ai',
	'databricks',
	'deepseek',
	'digitalocean',
	'fireworks-ai',
	'huggingface',
	'inception',
	'kilo',
	'minimax',
	'moonshotai',
	'morph',
	'nebius',
	'novita-ai',
	'nvidia',
	'opencode',
	'opencode-go',
	'poe',
	'requesty',
	'siliconflow',
	'siliconflow-cn',
	'snowflake-cortex',
	'stepfun',
	'upstage',
	'wandb',
	'zai',
	'zhipuai',
];

/** Whether this extension ships a vendor for the given catalog provider. */
export function isShippedProvider(id: string): boolean {
	return SHIPPED_PROVIDERS.includes(id);
}
