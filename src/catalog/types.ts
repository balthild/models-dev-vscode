// Wire shapes of the models.dev catalog. Only the fields this extension reads are
// modelled; the published catalog carries substantially more.
//
// Reference: https://github.com/anomalyco/models.dev (API reference in README.md).

/** A kind of data a model accepts or produces. */
export type Modality = 'text' | 'audio' | 'image' | 'video' | 'pdf';

/** A model's specialized behaviour. Ordinary generative chat models omit it. */
export type ModelType =
	| 'chat'
	| 'image'
	| 'video'
	| 'embedding'
	| 'reranking'
	| 'decision'
	| 'transcription'
	| 'speech'
	| 'realtime';

/** Lifecycle marker. Absent means generally available. */
export type ModelStatus = 'alpha' | 'beta' | 'deprecated';

/**
 * A reasoning effort level a provider accepts.
 *
 * `null` is distinct from `'none'`: the catalog uses it to say that the provider takes an explicit
 * request to turn reasoning off, rather than exposing an off level among the efforts.
 */
export type ReasoningEffortLevel =
	| 'none'
	| 'minimal'
	| 'low'
	| 'medium'
	| 'high'
	| 'xhigh'
	| 'max'
	| 'default';

/** How reasoning can be configured for a model. */
export type ReasoningOption =
	| { readonly type: 'toggle' }
	| { readonly type: 'effort'; readonly values: readonly (ReasoningEffortLevel | null)[] }
	| { readonly type: 'budget_tokens'; readonly min?: number; readonly max?: number };

/** Input and output data kinds a model supports. */
export interface Modalities {
	readonly input: readonly Modality[];
	readonly output: readonly Modality[];
}

/** Token limits as served by one provider. */
export interface Limit {
	/** Full context window, input plus output. */
	readonly context: number;
	/** Maximum input tokens, when the host caps it below the window. */
	readonly input?: number;
	/** Maximum output tokens. */
	readonly output: number;
}

/**
 * SDK wiring for one model, for hosts that differ from their provider's default. `shape` selects
 * the API surface when the package serves more than one.
 */
export interface ModelProviderConfig {
	readonly npm?: string;
	readonly api?: string;
	readonly shape?: 'responses' | 'completions';
}

/** A model as offered by one provider, with that provider's limits. */
export interface CatalogModel {
	readonly id: string;
	/** Canonical `<lab>/<model>` id this offering derives from, when it is a copy. */
	readonly canonical_model_id?: string;
	readonly type?: ModelType;
	readonly name: string;
	readonly description?: string;
	readonly family?: string;
	/** Whether the model accepts file attachments. */
	readonly attachment?: boolean;
	readonly reasoning?: boolean;
	readonly reasoning_options?: readonly ReasoningOption[];
	readonly tool_call?: boolean;
	readonly temperature?: boolean;
	readonly structured_output?: boolean;
	readonly modalities?: Modalities;
	readonly limit?: Limit;
	readonly status?: ModelStatus;
	readonly release_date?: string;
	readonly last_updated?: string;
	readonly provider?: ModelProviderConfig;
}

/** An inference provider and the models it serves. */
export interface CatalogProvider {
	readonly id: string;
	readonly name: string;
	/** AI SDK package implementing this provider's wire format. */
	readonly npm: string;
	/** Base API URL. Present for providers reachable as a plain HTTPS endpoint. */
	readonly api?: string;
	readonly doc?: string;
	readonly models: Record<string, CatalogModel>;
}

/** The subset of `catalog.json` this extension consumes. */
export interface Catalog {
	readonly providers: Record<string, CatalogProvider>;
}
