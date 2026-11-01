import type { NeutralReasoning } from './types.ts';

/**
 * The `LanguageModelThinkingPart.metadata` keys carrying replay state.
 *
 * These exact names are what the host preserves when it rebuilds a conversation, and what the
 * built-in providers use, so a private key risks being dropped.
 */
export const REASONING_METADATA = {
	signature: 'signature',
	complete: '_completeThinking',
	redacted: 'redactedData',
} as const;

/** Replay state as it travels on a reasoning part. */
export interface ReasoningState {
	/** The part's own id, which some protocols replay alongside the state. */
	readonly id?: string;
	/** Opaque state proving the block came from the model. */
	readonly signature?: string;
	/** The block's full text, which streams in fragments and is only sent here. */
	readonly complete?: string;
	/** A withheld block's opaque payload. */
	readonly redacted?: string;
}

/**
 * Read replay state off a reasoning part.
 *
 * Duck-typed rather than checked with `instanceof`: the part is declared in a proposed API, so an
 * older host may not define the class at all.
 */
export function readReasoningState(part: unknown): ReasoningState {
	const { id, metadata } = (part ?? {}) as { id?: unknown; metadata?: unknown };
	const fields = readRecord(metadata);

	return {
		id: asString(id),
		signature: asString(fields[REASONING_METADATA.signature]),
		complete: asString(fields[REASONING_METADATA.complete]),
		redacted: asString(fields[REASONING_METADATA.redacted]),
	};
}

/**
 * Convert replay state into something worth sending back.
 *
 * @returns `undefined` when the block cannot be verified. A part that only holds display text
 *   carries no proof it came from the model, and sending it back is exactly what the Messages API
 *   rejects.
 */
export function replayableReasoning(state: ReasoningState): NeutralReasoning | undefined {
	if (isFilled(state.redacted)) {
		return { id: state.id, text: '', redacted: state.redacted };
	}

	if (!isFilled(state.signature)) {
		return undefined;
	}

	return { id: state.id, text: state.complete ?? '', signature: state.signature };
}

/**
 * Build the metadata to report alongside a reasoning block.
 *
 * The counterpart to {@link readReasoningState}, so the two cannot disagree about a key name.
 */
export function reasoningMetadata(
	state: Pick<NeutralReasoning, 'text' | 'signature' | 'redacted'>,
): Readonly<Record<string, unknown>> {
	return {
		...(state.signature === undefined ? {} : { [REASONING_METADATA.signature]: state.signature }),
		// Only the complete text travels here; the fragments streamed for display carry no state.
		...(state.text === '' ? {} : { [REASONING_METADATA.complete]: state.text }),
		...(state.redacted === undefined ? {} : { [REASONING_METADATA.redacted]: state.redacted }),
	};
}

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function isFilled(value: string | undefined): value is string {
	return value !== undefined && value !== '';
}
