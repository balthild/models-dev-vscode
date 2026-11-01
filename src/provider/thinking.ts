import * as vscode from 'vscode';

/**
 * The shape the host's reasoning part is constructed with.
 *
 * Declared here rather than used from `vscode` because the class lives in the proposed
 * languageModelThinkingPart API, which the published typings do not include.
 */
export type ThinkingPartConstructor = new (
	value: string,
	id?: string,
	metadata?: Readonly<Record<string, unknown>>,
) => object;

/**
 * The host's reasoning part constructor.
 *
 * @returns `undefined` on a host that predates the part, in which case reasoning is display-only.
 */
export function thinkingPartConstructor(): ThinkingPartConstructor | undefined {
	const candidate = (vscode as unknown as { LanguageModelThinkingPart?: unknown })
		.LanguageModelThinkingPart;

	return typeof candidate === 'function' ? (candidate as ThinkingPartConstructor) : undefined;
}
