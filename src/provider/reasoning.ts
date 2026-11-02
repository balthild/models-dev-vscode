import type { ThinkingContent } from '@earendil-works/pi-ai';

/**
 * The `LanguageModelThinkingPart.metadata` keys that carry replay state.
 *
 * These exact names are what the host preserves when it rebuilds a conversation, and what the
 * built-in providers use, so a private key risks being dropped.
 */
export const REASONING_METADATA = {
	signature: 'signature',
	complete: '_completeThinking',
	redacted: 'redactedData',
} as const;

/** What a reasoning block needs to be replayed on a later turn. */
export type ReplayableThinking = Pick<
	ThinkingContent,
	'thinking' | 'thinkingSignature' | 'redacted'
>;

/**
 * Build the metadata to report alongside a reasoning block.
 *
 * The provider library keeps everything a replay needs on the block itself: the text, the opaque
 * state in `thinkingSignature`, and a flag when that state stands in for withheld text. The host
 * only preserves three metadata keys, so the flag is encoded by which key carries the payload.
 *
 * @returns `undefined` when there is no state to replay, which is the ordinary case for a host that
 *   chunks reasoning for display without keeping where it came from.
 */
export function reasoningMetadata(
	content: ReplayableThinking,
): Readonly<Record<string, unknown>> | undefined {
	const state = content.thinkingSignature;
	if (state === undefined || state === '') {
		return undefined;
	}

	return {
		...(content.redacted === true
			? { [REASONING_METADATA.redacted]: state }
			: { [REASONING_METADATA.signature]: state }),
		// Only the complete text travels here; the fragments streamed for display carry no state.
		...(content.thinking === '' ? {} : { [REASONING_METADATA.complete]: content.thinking }),
	};
}

/**
 * Rebuild a reasoning block from the metadata the host handed back.
 *
 * @returns `undefined` when the block cannot be verified. A part carrying only display text was
 *   never signed, and APIs that require signatures reject replayed text without one.
 */
export function thinkingFromMetadata(metadata: unknown): ThinkingContent | undefined {
	const fields = readRecord(metadata);
	const redacted = asString(fields[REASONING_METADATA.redacted]);
	if (redacted !== undefined && redacted !== '') {
		return { type: 'thinking', thinking: '', thinkingSignature: redacted, redacted: true };
	}

	const signature = asString(fields[REASONING_METADATA.signature]);
	if (signature === undefined || signature === '') {
		return undefined;
	}

	return {
		type: 'thinking',
		thinking: asString(fields[REASONING_METADATA.complete]) ?? '',
		thinkingSignature: signature,
	};
}

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
