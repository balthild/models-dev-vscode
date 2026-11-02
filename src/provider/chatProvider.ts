import type { AssistantMessageEvent, ProviderStreams } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';

import { toModelInformation } from './modelInfo.ts';
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
	 * The options the host resolved from the manifest's `configuration` schema, which is where the
	 * API key lives.
	 *
	 * Only {@link provideLanguageModelChatInformation} receives them, so they are cached here for the
	 * requests that follow.
	 */
	private configuration: Readonly<Record<string, unknown>> | undefined;

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
		if (configuration !== undefined) {
			this.configuration = configuration;
		}

		return this.options.models().map(toModelInformation);
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

		const apiKey = readSetting(this.configuration, 'apiKey');
		if (apiKey === undefined) {
			throw new Error(
				`No API key is configured for ${this.options.vendor}. Add one from the model picker, or run "Models.dev: Open Provider Settings".`,
			);
		}

		const wireModel = toWireModel(neutral, {
			apiKey,
			baseUrl: readSetting(this.configuration, 'baseUrl') ?? neutral.baseUrl,
		});
		const stream = this.modelsFor(this.options.vendor).streamSimple(
			wireModel,
			{ messages: toWireMessages(messages, neutral), tools: toWireTools(options.tools) },
			{ apiKey, reasoning: toThinkingLevel(readEffort(options)), signal: toAbortSignal(token) },
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
	usage: { input: number; output: number } | undefined,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (usage === undefined) {
		return;
	}

	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(
				JSON.stringify({ prompt_tokens: usage.input, completion_tokens: usage.output }),
			),
			'usage',
		),
	);
}

/** Read a non-empty string out of the host-resolved provider configuration. */
function readSetting(
	configuration: Readonly<Record<string, unknown>> | undefined,
	key: string,
): string | undefined {
	const value = configuration?.[key];

	return typeof value === 'string' && value !== '' ? value : undefined;
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
