import * as vscode from 'vscode';

import type {
	NeutralImage,
	NeutralMessage,
	NeutralTool,
	NeutralToolCall,
	NeutralToolResult,
} from '../protocol/index.ts';

/** Convert the host's request messages into the protocol-neutral form. */
export function toNeutralMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): NeutralMessage[] {
	return messages.map(toNeutralMessage);
}

/** Convert the tools the host offers for a request. */
export function toNeutralTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): NeutralTool[] {
	return (tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
	}));
}

/** Whether the request requires a tool call rather than merely permitting one. */
export function requiresToolCall(mode: vscode.LanguageModelChatToolMode | undefined): boolean {
	return mode === vscode.LanguageModelChatToolMode.Required;
}

function toNeutralMessage(message: vscode.LanguageModelChatRequestMessage): NeutralMessage {
	let text = '';
	const images: NeutralImage[] = [];
	const toolCalls: NeutralToolCall[] = [];
	const toolResults: NeutralToolResult[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const image = toImage(part);
			if (image !== undefined) {
				images.push(image);
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			toolCalls.push({
				callId: part.callId,
				name: part.name,
				// The host hands over parsed input; the wire formats all expect text.
				arguments: JSON.stringify(part.input ?? {}),
			});
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			toolResults.push(toToolResult(part));
		}
	}

	return {
		role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
		text,
		images,
		toolCalls,
		toolResults,
	};
}

function toToolResult(part: vscode.LanguageModelToolResultPart): NeutralToolResult {
	let text = '';
	const images: NeutralImage[] = [];

	for (const content of part.content) {
		if (content instanceof vscode.LanguageModelTextPart) {
			text += content.value;
		} else if (content instanceof vscode.LanguageModelDataPart) {
			const image = toImage(content);
			if (image !== undefined) {
				images.push(image);
			}
		}
	}

	return { callId: part.callId, text, images };
}

/**
 * Read a data part as an image.
 *
 * Only images are passed on: the other data parts on this API carry protocol bookkeeping rather
 * than anything a model can consume.
 */
function toImage(part: vscode.LanguageModelDataPart): NeutralImage | undefined {
	return part.mimeType.startsWith('image/')
		? { data: part.data, mimeType: part.mimeType }
		: undefined;
}
