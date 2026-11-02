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
 * `cost` is filled with zeroes because nothing in this extension reports spend, and leaving it
 * absent would only make the library estimate one.
 *
 * @param model The catalog model to project.
 * @param vendor The catalog provider id, which is also the id the provider was registered under.
 *   The library dispatches a request by this id, so it has to match that registration rather than
 *   the wire protocol the model happens to use.
 * @param auth Credentials and endpoint for this request.
 */
export function toWireModel(model: NeutralModel, vendor: string, auth: WireAuth): Model<Api> {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		provider: vendor,
		baseUrl: auth.baseUrl,
		reasoning: model.reasoning.supported,
		input: model.imageInput ? ['text', 'image'] : ['text'],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxOutputTokens,
	};
}
