import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import { toWireMessages } from '#/provider/request.ts';

const MODEL: NeutralModel = {
	id: 'example-model',
	name: 'Example Model',
	family: 'example',
	version: '2026-01-01',
	api: 'openai-completions',
	baseUrl: 'https://catalog.test/v1',
	contextWindow: 100_000,
	maxInputTokens: 90_000,
	maxOutputTokens: 10_000,
	imageInput: true,
	toolCalling: true,
	reasoning: {
		supported: false,
		efforts: [],
		canDisable: false,
		always: false,
		defaultChoice: 'disabled',
	},
};

type Part = vscode.LanguageModelInputPart | unknown;

function message(
	role: vscode.LanguageModelChatMessageRole,
	content: readonly Part[],
): vscode.LanguageModelChatRequestMessage {
	return { role, content, name: undefined };
}

function user(content: readonly Part[]): vscode.LanguageModelChatRequestMessage {
	return message(vscode.LanguageModelChatMessageRole.User, content);
}

function assistant(content: readonly Part[]): vscode.LanguageModelChatRequestMessage {
	return message(vscode.LanguageModelChatMessageRole.Assistant, content);
}

/** Every message the provider would receive, as the shape that reaches it. */
function wire(messages: readonly vscode.LanguageModelChatRequestMessage[]) {
	return toWireMessages(messages, MODEL);
}

/**
 * Whether the provider would be sent a user or assistant turn with nothing in it.
 *
 * Tool results are left out: a tool that returned nothing is the library's business, and it
 * substitutes a placeholder of its own for an empty one.
 */
function hasEmptyTurn(messages: ReturnType<typeof wire>): boolean {
	return messages.some(
		(entry) =>
			(entry.role === 'user' || entry.role === 'assistant') &&
			(Array.isArray(entry.content) ? entry.content.length === 0 : entry.content === ''),
	);
}

describe('toWireMessages', () => {
	test('sends no empty message for a turn of tool results', () => {
		const messages = wire([
			user([new vscode.LanguageModelTextPart('read the file')]),
			assistant([new vscode.LanguageModelToolCallPart('call_1', 'read_file', { path: 'a.ts' })]),
			user([new vscode.LanguageModelToolResultPart('call_1', [])]),
		]);

		// The turn of results has no text and no image of its own. Sending it empty fails the entire
		// request with "user message must have content".
		assert.equal(hasEmptyTurn(messages), false);
		assert.deepEqual(
			messages.map((entry) => entry.role),
			['user', 'assistant', 'toolResult'],
		);
	});

	/**
	 * The case seen in the wild, taken from a stored session: a tool that produced no output is kept
	 * as `{ callId: { content: [] } }`, which the host turns into a user message whose only part is
	 * that empty result. Emitting the wrapper empty failed the whole request.
	 */
	test('still answers a tool call whose result is empty', () => {
		const messages = wire([
			assistant([new vscode.LanguageModelToolCallPart('call_1', 'edit_file', {})]),
			user([new vscode.LanguageModelToolResultPart('call_1', [])]),
		]);

		assert.deepEqual(
			messages.map((entry) => entry.role),
			['assistant', 'toolResult'],
		);

		const result = messages[1];

		// Kept, so the call is answered — the library substitutes its own placeholder for the empty
		// content.
		assert.deepEqual(result?.role === 'toolResult' ? result.content : undefined, []);
	});

	test('takes the tool name from the call that asked for the result', () => {
		const messages = wire([
			assistant([new vscode.LanguageModelToolCallPart('call_1', 'read_file', { path: 'a.ts' })]),
			user([new vscode.LanguageModelToolResultPart('call_1', [])]),
		]);

		const result = messages.find((entry) => entry.role === 'toolResult');

		// Only gateways with `compat.requiresToolResultName` read it, and an empty name cannot supply
		// it.
		assert.equal(result?.role === 'toolResult' ? result.toolName : undefined, 'read_file');
	});

	test('keeps a user message whose only content is an image', () => {
		const messages = wire([
			user([new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), 'image/png')]),
		]);

		assert.equal(messages.length, 1);
		assert.equal(messages[0]?.role, 'user');
	});

	test('drops a user message it cannot represent, rather than sending it empty', () => {
		const messages = wire([
			user([new vscode.LanguageModelDataPart(new Uint8Array([1]), 'application/pdf')]),
		]);

		assert.deepEqual(messages, []);
	});

	test('carries text alongside tool results of the same turn', () => {
		const messages = wire([
			user([
				new vscode.LanguageModelTextPart('here it is'),
				new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('x')]),
			]),
		]);

		assert.deepEqual(
			messages.map((entry) => entry.role),
			['user', 'toolResult'],
		);
	});

	test('stamps the model on every replayed assistant turn', () => {
		const messages = wire([assistant([new vscode.LanguageModelTextPart('hello')])]);
		const [first] = messages;

		assert.equal(first?.role, 'assistant');
		assert.equal(first?.role === 'assistant' ? first.model : undefined, MODEL.id);
		assert.equal(first?.role === 'assistant' ? first.provider : undefined, MODEL.api);
	});
});
