import * as vscode from 'vscode';

/**
 * Estimate the number of tokens in a request.
 *
 * Deliberately approximate. The catalog names no tokenizer, and the models behind this extension
 * are served by a dozen providers that each use a different one, so no exact answer is reachable
 * from here. About four characters per token suits both prose and code closely enough for a context
 * budget.
 */
export function countTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
	return typeof text === 'string' ? estimate(text) : countMessage(text);
}

function countMessage(message: vscode.LanguageModelChatRequestMessage): number {
	let total = 0;

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += estimate(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			total += estimate(part.name) + estimate(JSON.stringify(part.input ?? {}));
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			total += estimate(JSON.stringify(part.content));
		} else if (part instanceof vscode.LanguageModelDataPart) {
			// An image costs a flat allowance rather than its encoded size, which
			// says nothing about what the model charges for it.
			total += IMAGE_TOKENS;
		}
	}

	return total;
}

function estimate(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

const CHARACTERS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_000;
