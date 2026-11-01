import type { SseEvent } from './types.ts';

/** Incrementally splits a byte stream into server-sent events. */
export interface SseParser {
	push(chunk: Uint8Array): SseEvent[];
	/** Finish the stream, emitting anything the final chunk left unflushed. */
	end(): SseEvent[];
}

/** @see https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation */
export function createSseParser(): SseParser {
	const decoder = new TextDecoder();
	let buffer = '';
	let eventName: string | undefined;
	let dataLines: string[] = [];

	const drain = (): SseEvent[] => {
		const events: SseEvent[] = [];

		for (;;) {
			const newline = buffer.indexOf('\n');
			if (newline === -1) {
				break;
			}

			const line = stripCarriageReturn(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);

			if (line === '') {
				if (dataLines.length > 0) {
					events.push({ event: eventName, data: dataLines.join('\n') });
				}
				eventName = undefined;
				dataLines = [];
				continue;
			}

			// A line starting with a colon is a comment, which keep-alive pings use.
			if (line.startsWith(':')) {
				continue;
			}

			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			const rawValue = colon === -1 ? '' : line.slice(colon + 1);
			// A single leading space after the colon belongs to the framing.
			const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

			if (field === 'event') {
				eventName = value;
			} else if (field === 'data') {
				dataLines.push(value);
			}
		}

		return events;
	};

	return {
		push(chunk: Uint8Array): SseEvent[] {
			buffer += decoder.decode(chunk, { stream: true });

			return drain();
		},

		end(): SseEvent[] {
			buffer += decoder.decode();

			const events = drain();
			// A stream that ends without its terminating blank line still has one
			// event pending.
			if (dataLines.length > 0) {
				events.push({ event: eventName, data: dataLines.join('\n') });
				eventName = undefined;
				dataLines = [];
			}

			return events;
		},
	};
}

function stripCarriageReturn(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}
