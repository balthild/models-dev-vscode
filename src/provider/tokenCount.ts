import type { TikTokenizer } from '@microsoft/tiktokenizer';
import {
	createTokenizer,
	getRegexByEncoder,
	getSpecialTokensByEncoder,
} from '@microsoft/tiktokenizer';
import * as vscode from 'vscode';

/**
 * The encoding used for every model.
 *
 * The catalog names no tokenizer and none of these providers exposes a counting endpoint, so one
 * encoding has to serve all of them. `o200k_base` is the closest general-purpose approximation
 * available offline, but it is OpenAI's: for a Claude or Qwen model the count is still an estimate,
 * just a much better one than counting characters.
 */
const ENCODING = 'o200k_base';

/** Used until the tokenizer is loaded, and if it cannot be. */
const CHARACTERS_PER_TOKEN = 4;

/**
 * A flat allowance per image.
 *
 * The encoded size of an image says little about what a model charges for it, and every provider's
 * rule differs.
 */
const IMAGE_TOKENS = 1_000;

let tokenizer: TikTokenizer | undefined;

/**
 * Load the tokenizer from the bundled ranks file.
 *
 * @param ranksPath Absolute path of the ranks file shipped with the extension.
 * @throws When the file is missing or unreadable, which leaves counting approximate.
 */
export function loadTokenizer(ranksPath: string): void {
	tokenizer ??= createTokenizer(
		ranksPath,
		getSpecialTokensByEncoder(ENCODING),
		getRegexByEncoder(ENCODING),
	);
}

/** Count the tokens in a request or a raw string. */
export function countTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
	return typeof text === 'string' ? encode(text) : countMessage(text);
}

function countMessage(message: vscode.LanguageModelChatRequestMessage): number {
	let total = 0;

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += encode(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			total += encode(part.name) + encode(JSON.stringify(part.input ?? {}));
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			total += encode(JSON.stringify(part.content));
		} else if (part instanceof vscode.LanguageModelDataPart) {
			total += IMAGE_TOKENS;
		}
	}

	return total;
}

function encode(text: string): number {
	if (tokenizer === undefined) {
		return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
	}

	return tokenizer.encode(text).length;
}
