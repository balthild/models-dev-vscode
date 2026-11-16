import type {
	ImageContent,
	Message,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from '@earendil-works/pi-ai';
import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';

import { thinkingFromMetadata } from './reasoning.ts';

/** Convert the host's tools into the provider library's shape. */
export function toWireTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Tool[] {
	return (tools ?? []).map((tool) => ({
		name: tool.name,
		description: tool.description,
		// The host validates tool input against this schema before invoking it.
		parameters: tool.inputSchema as Tool['parameters'],
	}));
}

/**
 * Convert the host's conversation into the provider library's messages.
 *
 * Two things the host's vocabulary does not carry across on its own are handled here. Reasoning is
 * replayed only for messages whose recorded model still matches, and the host does not say which
 * model produced each past turn, so the current model is stamped on every one. And a tool result
 * names only the call it answers — the tool's own name is on that call, in an earlier message — so
 * the names are collected from the calls as the conversation is walked.
 *
 * @param model The model the request is for.
 */
export function toWireMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	model: NeutralModel,
): Message[] {
	const wire: Message[] = [];
	const toolNames = new Map<string, string>();

	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNames.set(part.callId, part.name);
			}
		}

		const own = toWireMessage(message, model);
		if (own !== undefined) {
			wire.push(own);
		}

		wire.push(...toWireToolResults(message, toolNames));
	}

	return wire;
}

/**
 * A message's own content, or `undefined` when it has none the provider could read.
 *
 * A tool result can only appear in a user message, so a turn carrying nothing but results is
 * ordinary: it has no text and no image of its own, and what it does carry is sent as the tool
 * results that follow. Emitting it empty would fail the whole request — `user message must have
 * content`.
 */
function toWireMessage(
	message: vscode.LanguageModelChatRequestMessage,
	model: NeutralModel,
): Message | undefined {
	if (message.role !== vscode.LanguageModelChatMessageRole.User) {
		return assistantMessage(message.content, model);
	}

	const images = message.content.filter(isImagePart);
	const text = textOf(message.content);
	if (text === '' && images.length === 0) {
		return undefined;
	}

	return {
		role: 'user',
		content:
			images.length === 0
				? text
				: [
						...(text === '' ? [] : [{ type: 'text' as const, text }]),
						...images.map(toImageContent),
					],
		timestamp: Date.now(),
	};
}

function assistantMessage(
	parts: vscode.LanguageModelChatRequestMessage['content'],
	model: NeutralModel,
): Message {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];

	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			if (part.value !== '') {
				content.push({ type: 'text', text: part.value });
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			content.push({
				type: 'toolCall',
				id: part.callId,
				name: part.name,
				arguments: asJsonObject(part.input),
			});
		} else {
			// A reasoning part is declared in a proposed API, so it is identified by shape rather
			// than with `instanceof`.
			const thinking = thinkingFromMetadata((part as { metadata?: unknown }).metadata);
			if (thinking !== undefined) {
				content.push(thinking);
			}
		}
	}

	return {
		role: 'assistant',
		content,
		// Stamping the current model is what lets the library replay reasoning at all; see
		// {@link toWireMessages}.
		api: model.api,
		provider: model.api,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: 'stop',
		timestamp: Date.now(),
	};
}

/**
 * Tool results, which the host delivers as content of a user message.
 *
 * The library carries the tool's name on the result; the host does not, and the call the result
 * answers is in an earlier message, so the name is looked up among the calls seen so far. A gateway
 * needing the name is told it through the model's `compat`, and the name is the only thing that can
 * supply it.
 */
function toWireToolResults(
	message: vscode.LanguageModelChatRequestMessage,
	names: ReadonlyMap<string, string>,
): Message[] {
	return message.content.flatMap((part): Message[] => {
		if (!(part instanceof vscode.LanguageModelToolResultPart)) {
			return [];
		}

		const content: (TextContent | ImageContent)[] = [];
		for (const item of part.content) {
			if (item instanceof vscode.LanguageModelTextPart) {
				content.push({ type: 'text', text: item.value });
			} else if (isImagePart(item)) {
				content.push(toImageContent(item));
			}
		}

		return [
			{
				role: 'toolResult',
				toolCallId: part.callId,
				toolName: names.get(part.callId) ?? '',
				content,
				isError: false,
				timestamp: Date.now(),
			},
		];
	});
}

function textOf(parts: vscode.LanguageModelChatRequestMessage['content']): string {
	return parts
		.filter(
			(part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart,
		)
		.map((part) => part.value)
		.join('');
}

function toImageContent(part: vscode.LanguageModelDataPart): ImageContent {
	return {
		type: 'image',
		data: Buffer.from(part.data).toString('base64'),
		mimeType: part.mimeType,
	};
}

function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/');
}

function asJsonObject(value: unknown): ToolCall['arguments'] {
	return typeof value === 'object' && value !== null ? (value as ToolCall['arguments']) : {};
}

/**
 * A placeholder for replayed turns.
 *
 * The library reports usage for turns it performed; a turn being replayed was already counted when
 * it happened.
 */
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
