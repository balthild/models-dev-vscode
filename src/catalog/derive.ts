import type { ProtocolId } from './protocol.ts';
import { resolveProtocol } from './protocol.ts';
import type { ReasoningProfile } from './reasoning.ts';
import { deriveReasoning } from './reasoning.ts';
import type { CatalogModel, CatalogProvider, Modality } from './types.ts';

/**
 * A model reduced to what the extension needs, independent of the catalog's shape and of the host
 * API.
 */
export interface NeutralModel {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	/** Model lineage, used to group and select models. */
	readonly family: string;
	readonly version: string;
	readonly protocol: ProtocolId;
	/** Base API URL, without the protocol's path. */
	readonly baseUrl: string;
	readonly contextWindow: number;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly imageInput: boolean;
	readonly toolCalling: boolean;
	readonly reasoning: ReasoningProfile;
}

export interface DeriveInput {
	readonly provider: CatalogProvider;
	readonly model: CatalogModel;
}

/**
 * Reduce a catalog entry to a `NeutralModel`.
 *
 * @returns The model, or `undefined` when it cannot be served: deprecated, not a text-generating
 *   chat model, on a protocol this extension cannot speak, or without a usable base URL.
 */
export function deriveModel({ provider, model }: DeriveInput): NeutralModel | undefined {
	const limit = model.limit;
	if (
		model.status === 'deprecated' ||
		!servesChat(model) ||
		limit === undefined ||
		limit.output <= 0
	) {
		return undefined;
	}

	const protocol = resolveProtocol(model.provider?.npm ?? provider.npm, model.provider?.shape);
	// A model-specific endpoint wins: hosts can serve one model from a different
	// base than the rest of the provider.
	const baseUrl = model.provider?.api ?? provider.api;
	if (protocol === undefined || baseUrl === undefined) {
		return undefined;
	}

	return {
		id: model.id,
		name: model.name,
		description: model.description,
		family: model.family ?? provider.id,
		version: model.last_updated ?? model.release_date ?? '1',
		protocol,
		baseUrl,
		contextWindow: limit.context,
		// The catalog often omits the input cap. Deriving it from the window keeps
		// the reported budget inside what the model can actually hold.
		maxInputTokens: limit.input ?? Math.max(1, limit.context - limit.output),
		maxOutputTokens: limit.output,
		imageInput: accepts(model, 'image'),
		toolCalling: model.tool_call === true,
		reasoning: deriveReasoning(model),
	};
}

/** Every servable model a provider offers, ordered by id. */
export function deriveProviderModels(provider: CatalogProvider): NeutralModel[] {
	return Object.values(provider.models)
		.map((model) => deriveModel({ provider, model }))
		.filter((model): model is NeutralModel => model !== undefined)
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether a model produces text, which is what a chat model must do. An absent modality list leaves
 * the question open; only an explicit non-text output disqualifies it.
 */
function servesChat(model: CatalogModel): boolean {
	if (model.type !== undefined && model.type !== 'chat') {
		return false;
	}

	const output = model.modalities?.output;

	return output === undefined || output.includes('text');
}

function accepts(model: CatalogModel, modality: Modality): boolean {
	return model.modalities?.input.includes(modality) ?? false;
}
