import type { ProtocolId } from '#/catalog/protocol.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';

/** An image attached to a turn. */
export interface NeutralImage {
	readonly data: Uint8Array;
	readonly mimeType: string;
}

/** A tool call the model asked for. */
export interface NeutralToolCall {
	readonly callId: string;
	readonly name: string;
	/** Arguments as raw JSON text, exactly as the model produced them. */
	readonly arguments: string;
}

/** The outcome of running a tool. */
export interface NeutralToolResult {
	readonly callId: string;
	readonly text: string;
	readonly images: readonly NeutralImage[];
}

/**
 * Reasoning a provider requires back verbatim before it accepts the rest of the turn.
 *
 * Only a block that carries proof it came from the model belongs here: the Messages API rejects a
 * thinking block with no signature, so an unsigned block has to be left out rather than risk a
 * rejected request.
 */
export interface NeutralReasoning {
	/** Provider identifier for the block, when replay needs one. */
	readonly id?: string;
	/** The reasoned text. Empty when the provider withheld it. */
	readonly text: string;
	/** Opaque state proving the block came from the model. */
	readonly signature?: string;
	/** A withheld block's opaque payload, which stands in for its text. */
	readonly redacted?: string;
}

/** One chat turn, in a shape no particular wire protocol owns. */
export interface NeutralMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly images: readonly NeutralImage[];
	readonly toolCalls: readonly NeutralToolCall[];
	readonly toolResults: readonly NeutralToolResult[];
	readonly reasoning: readonly NeutralReasoning[];
}

/** A tool offered to the model. */
export interface NeutralTool {
	readonly name: string;
	readonly description: string;
	/** JSON Schema for the tool's input. */
	readonly parameters: unknown;
}

/** Reasoning settings for one request. */
export interface ReasoningRequest {
	/** Absent when the user left reasoning alone. */
	readonly choice?: EffortChoice;
	/** Token bounds, when the model expresses reasoning as a budget. */
	readonly budget?: { readonly min?: number; readonly max?: number };
}

/** Everything an adapter needs to build one request. */
export interface BuildInput {
	/** Model id as the provider expects it on the wire. */
	readonly modelId: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly messages: readonly NeutralMessage[];
	readonly tools: readonly NeutralTool[];
	/** Whether the caller insists on a tool call. */
	readonly requireToolCall: boolean;
	readonly maxOutputTokens: number;
	readonly reasoning: ReasoningRequest;
}

/** An HTTP request ready to be sent. */
export interface ProtocolRequest {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** An incremental update decoded from a response stream. */
export type NeutralEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'thinking'; readonly text: string }
	| {
			/**
			 * Opaque state belonging to the reasoning block that preceded it, reported once per block.
			 *
			 * Without it the next turn loses the model's own reasoning, and on some APIs is rejected
			 * outright.
			 */
			readonly kind: 'thinkingState';
			readonly id?: string;
			readonly text: string;
			readonly signature?: string;
			readonly redacted?: string;
	  }
	| {
			readonly kind: 'toolCall';
			readonly callId: string;
			readonly name: string;
			readonly arguments: string;
	  }
	| {
			readonly kind: 'usage';
			readonly inputTokens?: number;
			readonly outputTokens?: number;
	  };

/** Decodes one response stream. Stateful: create one per request. */
export interface StreamDecoder {
	/** Decode one server-sent event. */
	push(event: SseEvent): NeutralEvent[];
	/**
	 * Any events held back until the stream ended, such as a tool call whose arguments only parsed at
	 * the last chunk.
	 */
	flush(): NeutralEvent[];
}

/** A wire protocol this extension can speak. */
export interface ProtocolAdapter {
	readonly id: ProtocolId;
	buildRequest(input: BuildInput): ProtocolRequest;
	startStream(): StreamDecoder;
}

/** One server-sent event. */
export interface SseEvent {
	/** The `event:` field, when the stream sets one. */
	readonly event?: string;
	/** The joined `data:` payload, which may span several lines. */
	readonly data: string;
}
