import type { AssistantMessageEvent, ProviderStreams, Usage } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';
import { COMMANDS } from '#/ids.ts';

import type { Credentials } from './credentials.ts';
import { credentialsOf } from './credentials.ts';
import { toModelInformation } from './modelInfo.ts';
import { reasoningMetadata, toThinkingLevel } from './reasoning.ts';
import { toWireMessages, toWireTools } from './request.ts';
import { thinkingPartConstructor } from './thinking.ts';
import { countTokens } from './tokenCount.ts';
import { toWireModel } from './wireModel.ts';

export interface ChatProviderOptions {
	/** Vendor id the host knows this provider by. */
	readonly vendor: string;
	/** Every model the named catalog provider offers, or none when it is not in the catalog. */
	models(providerId: string): readonly NeutralModel[];
	readonly log: vscode.LogOutputChannel;
}

/** What a request needs from the listing the model object came from. */
interface ListedModel {
	readonly model: NeutralModel;
	readonly credentials: Credentials;
}

/**
 * Serves one catalog provider's models to the host.
 *
 * Credentials arrive from a group's `configuration`, which the host prompts for and stores; nothing
 * here asks for them itself. Building the request is the provider library's business — this class
 * only translates between the host's vocabulary and the library's.
 */
export class CatalogChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly options: ChatProviderOptions;
	private readonly changes = new vscode.EventEmitter<void>();
	/** Built once, and dropped when the model list changes so it cannot go stale. */
	private collection: ReturnType<typeof createModels> | undefined;

	/**
	 * The listing each model object came from.
	 *
	 * A request names no group. The host builds the model names it shows and dispatches
	 * (`vendor/<group>/<id>`) itself, and hands the provider neither the group nor that name; what it
	 * does hand back is the very model object this provider returned for that group's listing. Object
	 * identity is therefore the only per-group handle that survives from listing to dispatch, and it
	 * answers what a request needs — which upstream serves the model, and with which key.
	 */
	private readonly listed = new WeakMap<object, ListedModel>();

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

	/**
	 * The models one group offers.
	 *
	 * A call that names no group must list nothing. The host asks twice: once with no configuration,
	 * for models belonging to no group, and again per configured group. Answering the first call puts
	 * a row in the picker that belongs to no group — it shows the vendor's name and cannot be
	 * removed, because there is nothing to remove.
	 *
	 * The interactive form of that call is Add Models asking this provider to run its own flow: a
	 * group needs a provider choice, which no manifest schema can offer.
	 */
	provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
	): vscode.LanguageModelChatInformation[] {
		// Declared in the proposed chatProvider API, so it is read defensively.
		const configuration = (options as { configuration?: Readonly<Record<string, unknown>> })
			.configuration;
		const credentials = credentialsOf(configuration);

		if (credentials === undefined) {
			if (options.silent === false) {
				void vscode.commands.executeCommand(COMMANDS.addProvider);
			}

			return [];
		}

		return this.options.models(credentials.provider).map((model) => {
			const listed = toModelInformation(model);

			this.listed.set(listed, { model, credentials });

			return listed;
		});
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		// Only a listed object carries the group it belongs to, and guessing one would mean sending
		// another group's key to the wrong endpoint.
		const listed = this.listed.get(model);
		if (listed === undefined) {
			throw new Error(
				`This model is no longer offered. Add it again through Add Models in the model picker.`,
			);
		}

		const wireModel = toWireModel(listed.model, this.options.vendor, {
			apiKey: listed.credentials.apiKey,
			baseUrl: listed.credentials.baseUrl ?? listed.model.baseUrl,
		});
		this.collection ??= buildCollection(this.options.vendor);
		const stream = this.collection.streamSimple(
			wireModel,
			{ messages: toWireMessages(messages, listed.model), tools: toWireTools(options.tools) },
			{
				apiKey: listed.credentials.apiKey,
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
