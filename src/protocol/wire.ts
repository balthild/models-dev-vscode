import type { NeutralEvent, SseEvent } from './types.ts';

/** Append a path to a base URL without doubling or dropping the separator. */
export function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** JSON request headers without authentication, which differs per protocol. */
export function jsonHeaders(): Record<string, string> {
	return { 'content-type': 'application/json', 'accept': 'text/event-stream' };
}

/** Whether an event is the OpenAI-style end-of-stream marker. */
export function isDone(event: SseEvent): boolean {
	return event.data.trim() === '[DONE]';
}

/**
 * Decode an SSE payload as a JSON object.
 *
 * Unparseable frames and the end-of-stream marker both yield `undefined`: a provider that emits a
 * stray frame should not abort an otherwise good stream.
 */
export function parseData(event: SseEvent): Record<string, unknown> | undefined {
	if (event.data === '' || isDone(event)) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(event.data);

		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

export function readArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

/**
 * Read reasoning text out of a delta.
 *
 * Providers disagree on both the field name and whether it holds a string or an object, so every
 * spelling seen in the wild is accepted.
 */
export function readReasoningText(source: Record<string, unknown>): string | undefined {
	for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
		const value = source[key];
		if (typeof value === 'string' && value !== '') {
			return value;
		}

		if (isRecord(value)) {
			const nested = readString(value.text) ?? readString(value.content);
			if (nested !== undefined && nested !== '') {
				return nested;
			}
		}
	}

	return undefined;
}

/** A fragment of a tool call as it arrives on the wire. */
export interface ToolCallFragment {
	readonly callId?: string;
	readonly name?: string;
	/** A slice of the arguments JSON, not the whole thing. */
	readonly arguments?: string;
}

export interface ToolCallBuffer {
	/** Merge a fragment for the given call. */
	push(key: string | number, fragment: ToolCallFragment): void;
	/**
	 * Emit every buffered call.
	 *
	 * Calls are held until the stream ends rather than emitted as soon as they parse: arguments
	 * arrive as fragments, and a partial object can parse before the rest of it lands.
	 */
	flush(): NeutralEvent[];
}

export function createToolCallBuffer(): ToolCallBuffer {
	const pending = new Map<string, { callId: string; name: string; args: string }>();

	return {
		push(key, fragment): void {
			const id = String(key);
			const entry = pending.get(id) ?? { callId: '', name: '', args: '' };

			if (fragment.callId !== undefined) {
				entry.callId = fragment.callId;
			}
			if (fragment.name !== undefined) {
				entry.name = fragment.name;
			}
			if (fragment.arguments !== undefined) {
				entry.args += fragment.arguments;
			}

			pending.set(id, entry);
		},

		flush(): NeutralEvent[] {
			const events: NeutralEvent[] = [];

			for (const entry of pending.values()) {
				if (entry.callId === '' || entry.name === '') {
					continue;
				}

				events.push({
					kind: 'toolCall',
					callId: entry.callId,
					name: entry.name,
					arguments: normalizeArguments(entry.args),
				});
			}

			pending.clear();

			return events;
		},
	};
}

/**
 * Normalize a tool call's arguments to JSON text.
 *
 * A tool that takes no parameters arrives as an empty string, which the host would otherwise fail
 * to parse.
 */
function normalizeArguments(text: string): string {
	return text.trim() === '' ? '{}' : text;
}
