import type {
	Catalog,
	CatalogModel,
	CatalogProvider,
	Limit,
	Modalities,
	ModelProviderConfig,
	ModelStatus,
	ModelType,
	ReasoningOption,
} from './types.ts';

/**
 * Parse a catalog payload into the shape the extension uses.
 *
 * The live `api.json` and the bundled snapshot share this shape, so both go through here, and each
 * entry is projected down to the fields the extension reads. Projecting rather than trusting
 * matters because the payload is remote: an unvalidated `limit.output` could reach the host as a
 * string.
 *
 * Entries that are not shaped like providers or models are dropped rather than failing the load.
 * One malformed provider should not cost the rest.
 *
 * @throws When the payload is not an object, or holds no usable provider — which is how a wholesale
 *   shape change, such as a wrapper object, surfaces.
 */
export function parseCatalog(payload: string): Catalog {
	const parsed: unknown = JSON.parse(payload);
	if (!isRecord(parsed)) {
		throw new Error('catalog payload is not an object');
	}

	const catalog: Record<string, CatalogProvider> = {};
	for (const [id, value] of Object.entries(parsed)) {
		const provider = projectProvider(id, value);
		if (provider !== undefined) {
			catalog[id] = provider;
		}
	}

	if (Object.keys(catalog).length === 0) {
		throw new Error('catalog holds no usable provider');
	}

	return catalog;
}

function projectProvider(fallbackId: string, value: unknown): CatalogProvider | undefined {
	if (!isRecord(value) || typeof value.name !== 'string' || typeof value.npm !== 'string') {
		return undefined;
	}

	const models: Record<string, CatalogModel> = {};
	if (isRecord(value.models)) {
		for (const [modelId, entry] of Object.entries(value.models)) {
			const model = projectModel(modelId, entry);
			if (model !== undefined) {
				models[modelId] = model;
			}
		}
	}

	return {
		id: typeof value.id === 'string' ? value.id : fallbackId,
		name: value.name,
		npm: value.npm,
		api: asString(value.api),
		models,
	};
}

function projectModel(id: string, value: unknown): CatalogModel | undefined {
	if (!isRecord(value) || typeof value.name !== 'string') {
		return undefined;
	}

	return {
		id,
		name: value.name,
		description: asString(value.description),
		family: asString(value.family),
		type: asString(value.type) as ModelType | undefined,
		attachment: asBoolean(value.attachment),
		reasoning: asBoolean(value.reasoning),
		reasoning_options: asArray<ReasoningOption>(value.reasoning_options),
		tool_call: asBoolean(value.tool_call),
		temperature: asBoolean(value.temperature),
		modalities: projectModalities(value.modalities),
		limit: projectLimit(value.limit),
		status: asString(value.status) as ModelStatus | undefined,
		release_date: asString(value.release_date),
		last_updated: asString(value.last_updated),
		provider: projectProviderConfig(value.provider),
	};
}

function projectModalities(value: unknown): Modalities | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return {
		input: asArray<Modalities['input'][number]>(value.input) ?? [],
		output: asArray<Modalities['output'][number]>(value.output) ?? [],
	};
}

function projectLimit(value: unknown): Limit | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return {
		context: asNumber(value.context) ?? 0,
		input: asNumber(value.input),
		output: asNumber(value.output) ?? 0,
	};
}

function projectProviderConfig(value: unknown): ModelProviderConfig | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	return {
		npm: asString(value.npm),
		api: asString(value.api),
		shape: asString(value.shape) as ModelProviderConfig['shape'],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] | undefined {
	return Array.isArray(value) ? (value as T[]) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}
