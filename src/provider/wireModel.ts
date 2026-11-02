import type { Api, Model } from '@earendil-works/pi-ai';

import type { NeutralModel } from '#/catalog/derive.ts';

/** How the provider library identifies the request credentials for one model. */
export interface WireAuth {
	readonly apiKey: string;
	readonly baseUrl: string;
}

/**
 * Project a catalog model onto the provider library's model type.
 *
 * Only identity, budget, capability and endpoint travel here; how a request is shaped for a
 * particular host is the library's business.
 *
 * `cost` is filled with zeroes because nothing in this extension reports spend, and leaving it
 * absent would make the library estimate one.
 */
export function toWireModel(model: NeutralModel, auth: WireAuth): Model<Api> {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		provider: model.api,
		baseUrl: auth.baseUrl,
		reasoning: model.reasoning.supported,
		input: model.imageInput ? ['text', 'image'] : ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutputTokens,
	};
}
