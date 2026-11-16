import type { AssistantMessageEvent, ProviderStreams, Usage } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';

import type { Credentials } from './credentials.ts';
import { credentialsOf } from './credentials.ts';
import { listableModels } from './modelInfo.ts';
import { reasoningMetadata, toThinkingLevel } from './reasoning.ts';
import { toWireMessages, toWireTools } from './request.ts';
import { thinkingPartConstructor } from './thinking.ts';
import { countTokens } from './tokenCount.ts';
import { toWireModel } from './wireModel.ts';

export interface ChatProviderOptions {
	/** Catalog provider id, which doubles as the VS Code vendor id. */
	readonly vendor: string;
	/** Models currently served for this vendor. */
	models(): readonly NeutralModel[];
	readonly log: vscode.LogOutputChannel;
}

/**
 * Serves one catalog provider's models to the host.
 *
 * Credentials arrive from the provider's `configuration` contribution, which the host prompts for
 * and stores; nothing here asks for them itself. Building the request is the provider library's
 * business — this class only translates between the host's vocabulary and the library's.
 */
export class CatalogChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly options: ChatProviderOptions;
	private readonly changes = new vscode.EventEmitter<void>();
	/** Built once, and dropped when the model list changes so it cannot go stale. */
	private collection: ReturnType<typeof createModels> | undefined;

	/**
	 * The credentials behind every model this provider listed.
	 *
	 * A request names no group. The host builds the model names it shows and dispatches
	 * (`vendor/<group>/<id>`) itself, and hands the provider neither the group nor that name; what it
	 * does hand back is the very model object this provider returned for that group's listing. Object
	 * identity is therefore the only per-group handle that survives from listing to dispatch, and it
	 * answers the one question a request carries — which key belongs to this model. A vendor the user
	 * adds twice keys each group's requests with its own credentials.
	 */
	private readonly credentialsByModel = new WeakMap<object, Credentials>();

	/** The last listing's credentials, for a request whose model object is not one of ours. */
	private lastCredentials: Credentials | undefined;

	/**
	 * The host only re-reads a provider's models after this event fires, so it has to be present for
	 * a catalog refresh to reach the picker.
	 */
	readonly onDidChangeLanguageModelChatInformation = this.changes.event;

	constructor(options: ChatProviderOptions) {
		this.options = options;
	}

	dispose(): void {
		this.changes.dispose();
	}

	/** Tell the host the model list changed. */
	notifyModelsChanged(): void {
		this.collection = undefined;
		this.changes.fire();
	}

	provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
	): vscode.LanguageModelChatInformation[] {
		// Declared in the proposed chatProvider API, so it is read defensively.
		const configuration = (options as { configuration?: Readonly<Record<string, unknown>> })
			.configuration;
		const credentials = credentialsOf(configuration);
		const models = listableModels(configuration, this.options.models());

		if (credentials !== undefined) {
			this.lastCredentials = credentials;
			for (const model of models) {
				this.credentialsByModel.set(model, credentials);
			}
		}

		return models;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const neutral = this.options.models().find((candidate) => candidate.id === model.id);
		if (neutral === undefined) {
			throw new Error(`This model is no longer offered by ${this.options.vendor}.`);
		}

		const credentials = this.credentialsFor(model);
		if (credentials === undefined) {
			throw new Error(
				`No API key is configured for ${this.options.vendor}. Add it through Add Models in the model picker.`,
			);
		}

		const wireModel = toWireModel(neutral, this.options.vendor, {
			apiKey: credentials.apiKey,
			baseUrl: credentials.baseUrl ?? neutral.baseUrl,
		});
		const stream = this.modelsFor(this.options.vendor).streamSimple(
			wireModel,
			{ messages: toWireMessages(messages, neutral), tools: toWireTools(options.tools) },
			{
				apiKey: credentials.apiKey,
				reasoning: toThinkingLevel(readEffort(options)),
				signal: toAbortSignal(token),
			},
		);

		for await (const event of stream) {
			report(event, progress, this.options.log);
		}

		const final = await stream.result();
		if (final.stopReason === 'error') {
			throw new Error(final.errorMessage ?? 'The provider returned an error.');
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
	): Promise<number> {
		return countTokens(text);
	}

	/**
	 * The credentials for the listing a request belongs to.
	 *
	 * The fallback covers a model object that did not come from a listing. Nothing in the host's
	 * model proxy does that today, but failing the request outright would be a worse outcome than
	 * using the credentials resolved most recently.
	 */
	private credentialsFor(model: object): Credentials | undefined {
		const listed = this.credentialsByModel.get(model);
		if (listed !== undefined) {
			return listed;
		}

		if (this.lastCredentials !== undefined) {
			this.options.log.warn(
				`[${this.options.vendor}] A request named a model this provider did not list. Falling back to the most recently resolved credentials.`,
			);
		}

		return this.lastCredentials;
	}

	/** The provider collection for a vendor, built on first use. */
	private modelsFor(vendor: string): ReturnType<typeof createModels> {
		this.collection ??= buildCollection(vendor);

		return this.collection;
	}
}

function buildCollection(vendor: string): ReturnType<typeof createModels> {
	const models = createModels();
	models.setProvider(
		createProvider({
			id: vendor,
			// Auth is supplied per request, so resolving it here would only duplicate it.
			auth: { apiKey: { name: vendor, resolve: () => Promise.resolve({ auth: {} }) } },
			// The models come from the catalog per request, so the provider listing stays empty.
			models: [],
			api: requestImplementations(),
		}),
	);

	return models;
}

/**
 * The request implementations this extension ships.
 *
 * A narrow set on purpose: these are the protocols describable with nothing but an API key and an
 * endpoint. Bedrock (SigV4 plus a region), Vertex (a project, a location and Google credentials)
 * and Azure (a deployment-based URL) need credentials this extension cannot collect.
 */
function requestImplementations(): Record<string, ProviderStreams> {
	return {
		'anthropic-messages': anthropicMessagesApi(),
		'openai-completions': openAICompletionsApi(),
		'openai-responses': openAIResponsesApi(),
	};
}

/** Convert the host's cancellation token into the signal the library expects. */
function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());

	return controller.signal;
}

function report(
	event: AssistantMessageEvent,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	log: vscode.LogOutputChannel,
): void {
	switch (event.type) {
		case 'text_delta':
			progress.report(new vscode.LanguageModelTextPart(event.delta));
			break;

		case 'thinking_delta': {
			const part = createThinkingPart(event.delta, log);
			if (part !== undefined) {
				progress.report(part);
			}
			break;
		}

		case 'thinking_end':
			// Whatever lets this block be replayed. Read from the block rather than the event,
			// because the event carries only the text.
			reportThinkingState(event, progress, log);
			break;

		case 'toolcall_end':
			progress.report(
				new vscode.LanguageModelToolCallPart(
					event.toolCall.id,
					event.toolCall.name,
					event.toolCall.arguments,
				),
			);
			break;

		case 'done':
			reportUsage(event.message.usage, progress);
			break;

		default:
			break;
	}
}

function reportThinkingState(
	event: Extract<AssistantMessageEvent, { type: 'thinking_end' }>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	log: vscode.LogOutputChannel,
): void {
	const block = event.partial.content[event.contentIndex];
	if (block?.type !== 'thinking') {
		return;
	}

	const metadata = reasoningMetadata(block);
	if (metadata === undefined) {
		// Nothing here can be replayed, so reporting a part would only add noise.
		return;
	}

	// Reported without text on purpose: the text already streamed, so repeating it here would show
	// the reasoning twice.
	const part = createThinkingPart('', log, undefined, metadata);
	if (part !== undefined) {
		progress.report(part);
	}
}

function reportUsage(
	usage: Usage,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	const prompt = promptTokens(usage);

	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(
				// Copilot Chat drops a usage part that has no `total_tokens`, and the context
				// window then reads 0%.
				JSON.stringify({
					prompt_tokens: prompt,
					completion_tokens: usage.output,
					total_tokens: prompt + usage.output,
					prompt_tokens_details: { cached_tokens: usage.cacheRead },
				}),
			),
			'usage',
		),
	);
}

/** `usage.input` excludes cache hits, which the host counts as prompt. */
function promptTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Read the reasoning level the user picked, if the host reported one. */
function readEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions,
): EffortChoice | undefined {
	const proposed = options as { modelConfiguration?: Readonly<Record<string, unknown>> };
	const chosen =
		proposed.modelConfiguration?.reasoningEffort ?? options.modelOptions?.reasoningEffort;

	return typeof chosen === 'string' ? (chosen as EffortChoice) : undefined;
}

/**
 * Build a reasoning part, if the host has one.
 *
 * `LanguageModelThinkingPart` is declared in the proposed languageModelThinkingPart API, so an
 * older host may not define it. Failing soft keeps reasoning a cosmetic loss rather than a broken
 * turn.
 */
function createThinkingPart(
	text: string,
	log: vscode.LogOutputChannel,
	id?: string,
	metadata?: Readonly<Record<string, unknown>>,
): vscode.LanguageModelResponsePart | undefined {
	const constructor = thinkingPartConstructor();
	if (constructor === undefined) {
		return undefined;
	}

	try {
		return new constructor(text, id, metadata) as vscode.LanguageModelResponsePart;
	} catch (error) {
		log.warn(`Could not report reasoning: ${String(error)}`);

		return undefined;
	}
}
