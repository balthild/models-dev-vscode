/** Upstream wire protocols this extension implements, one per adapter in `src/protocol`. */
export type ProtocolId = 'chatCompletions' | 'responses' | 'messages';

/**
 * AI SDK package to wire protocol.
 *
 * Routing by package rather than by provider id keeps a new relay provider working without a code
 * change. Providers served by other packages (Google's native generateContent, Amazon Bedrock,
 * Azure, Vertex) need credentials this extension cannot collect, so they are deliberately absent
 * and therefore unresolvable.
 */
const PACKAGE_PROTOCOLS: Readonly<Record<string, ProtocolId>> = {
	'@ai-sdk/openai': 'chatCompletions',
	'@ai-sdk/openai-compatible': 'chatCompletions',
	'@ai-sdk/anthropic': 'messages',
};

/**
 * Resolve the wire protocol for a model.
 *
 * @param npm The model's SDK package, falling back to its provider's.
 * @param shape The catalog's API-surface hint, for packages serving more than one.
 * @returns The protocol, or `undefined` when this extension cannot speak it.
 */
export function resolveProtocol(
	npm: string | undefined,
	shape: string | undefined,
): ProtocolId | undefined {
	if (npm === undefined) {
		return undefined;
	}

	const protocol = PACKAGE_PROTOCOLS[npm];
	if (protocol === undefined) {
		return undefined;
	}

	// Only the OpenAI packages expose a second surface, the Responses API.
	if (shape === 'responses' && protocol === 'chatCompletions') {
		return 'responses';
	}

	return protocol;
}
