/**
 * The parts of the `vscode` module this extension uses at runtime.
 *
 * The host injects the real module; under `node --test` the loader in `vscode-hook.ts` resolves the
 * specifier here instead, so code that talks to the host can be run and asserted on. Only runtime
 * values live here — the interfaces are erased, and every file stays typed against the real module
 * through `@types/vscode`.
 *
 * Nothing here is checked against the host, so a test failing on a missing method is the signal
 * that this stub needs another part of the API. Sections: parts, emitters.
 */

// MARK: Parts

export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 } as const;

export class LanguageModelTextPart {
	readonly value: string;

	constructor(value: string) {
		this.value = value;
	}
}

export class LanguageModelDataPart {
	readonly mimeType: string;
	readonly data: Uint8Array;

	constructor(data: Uint8Array, mimeType: string) {
		this.data = data;
		this.mimeType = mimeType;
	}

	static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
		return new LanguageModelDataPart(data, mimeType);
	}
}

export class LanguageModelToolCallPart {
	readonly callId: string;
	readonly name: string;
	readonly input: object;

	constructor(callId: string, name: string, input: object) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}

export class LanguageModelToolResultPart {
	readonly callId: string;
	readonly content: readonly unknown[];

	constructor(callId: string, content: readonly unknown[]) {
		this.callId = callId;
		this.content = content;
	}
}

/** The result of `renderElementJSON` from `@vscode/prompt-tsx`, as an opaque value. */
export class LanguageModelPromptTsxPart {
	readonly value: unknown;

	constructor(value: unknown) {
		this.value = value;
	}
}

export class LanguageModelThinkingPart {
	readonly value: string;
	readonly id: string | undefined;
	readonly metadata: Readonly<Record<string, unknown>> | undefined;

	constructor(value: string, id?: string, metadata?: Readonly<Record<string, unknown>>) {
		this.value = value;
		this.id = id;
		this.metadata = metadata;
	}
}

// MARK: Emitters

export class EventEmitter<T> {
	private readonly listeners = new Set<(value: T) => void>();

	/** An arrow property, so the host's `x.event` idiom survives being detached from the emitter. */
	readonly event = (listener: (value: T) => void): { dispose(): void } => {
		this.listeners.add(listener);

		return { dispose: (): boolean => this.listeners.delete(listener) };
	};

	fire(value: T): void {
		for (const listener of this.listeners) {
			listener(value);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}
