import type { ProtocolId } from '#/catalog/protocol.ts';

import { chatCompletionsAdapter } from './chatCompletions.ts';
import { messagesAdapter } from './messages.ts';
import { responsesAdapter } from './responses.ts';
import type { ProtocolAdapter } from './types.ts';

const ADAPTERS: Readonly<Record<ProtocolId, ProtocolAdapter>> = {
	chatCompletions: chatCompletionsAdapter,
	responses: responsesAdapter,
	messages: messagesAdapter,
};

/** The adapter for a wire protocol. Every {@link ProtocolId} is implemented. */
export function adapterFor(id: ProtocolId): ProtocolAdapter {
	return ADAPTERS[id];
}

export type {
	BuildInput,
	NeutralEvent,
	NeutralImage,
	NeutralMessage,
	NeutralTool,
	NeutralToolCall,
	NeutralToolResult,
	ProtocolRequest,
	ReasoningRequest,
	SseEvent,
	StreamDecoder,
} from './types.ts';
export { createSseParser } from './sse.ts';
export type { SseParser } from './sse.ts';
