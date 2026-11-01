import * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice } from '#/catalog/reasoning.ts';
import type { NeutralEvent, ProtocolRequest, StreamDecoder } from '#/protocol/index.ts';
import { adapterFor, createSseParser } from '#/protocol/index.ts';

import { toModelInformation } from './modelInfo.ts';
import { requiresToolCall, toNeutralMessages, toNeutralTools } from './request.ts';
import { countTokens } from './tokenCount.ts';

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
 * and stores; nothing here asks for them itself.
 */
export class CatalogChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly options: ChatProviderOptions;
	private readonly changes = new vscode.EventEmitter<void>();

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

		const adapter = adapterFor(neutral.protocol);
		const request = adapter.buildRequest({
			modelId: neutral.id,
			baseUrl: readSetting(this.configuration, 'baseUrl') ?? neutral.baseUrl,
			apiKey,
			messages: toNeutralMessages(messages),
			tools: toNeutralTools(options.tools),
			requireToolCall: requiresToolCall(options.toolMode),
			maxOutputTokens: neutral.maxOutputTokens,
			reasoning: { choice: readEffort(options), budget: neutral.reasoning.budget },
		});

		await stream(this.options.log, request, adapter.startStream(), progress, token);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
	): Promise<number> {
		return countTokens(text);
	}
}

async function stream(
	log: vscode.LogOutputChannel,
	request: ProtocolRequest,
	decoder: StreamDecoder,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	token: vscode.CancellationToken,
): Promise<void> {
	const controller = new AbortController();
	const cancellation = token.onCancellationRequested(() => controller.abort());

	try {
		const response = await fetch(request.url, {
			method: 'POST',
			headers: request.headers,
			body: request.body,
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(await describeFailure(response));
		}
		if (response.body === null) {
			throw new Error('The provider returned an empty response.');
		}

		const parser = createSseParser();
		const reader = response.body.getReader();

		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			for (const event of parser.push(value)) {
				report(decoder.push(event), progress, log);
			}
		}

		for (const event of parser.end()) {
			report(decoder.push(event), progress, log);
		}

		report(decoder.flush(), progress, log);
	} finally {
		cancellation.dispose();
	}
}

function report(
	events: readonly NeutralEvent[],
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	log: vscode.LogOutputChannel,
): void {
	for (const event of events) {
		switch (event.kind) {
			case 'text':
				progress.report(new vscode.LanguageModelTextPart(event.text));
				break;

			case 'thinking': {
				const part = createThinkingPart(event.text, log);
				if (part !== undefined) {
					progress.report(part);
				}
				break;
			}

			case 'toolCall':
				progress.report(
					new vscode.LanguageModelToolCallPart(
						event.callId,
						event.name,
						parseInput(event.arguments),
					),
				);
				break;

			case 'usage':
				progress.report(
					new vscode.LanguageModelDataPart(
						new TextEncoder().encode(
							JSON.stringify({
								prompt_tokens: event.inputTokens ?? 0,
								completion_tokens: event.outputTokens ?? 0,
							}),
						),
						'usage',
					),
				);
				break;
		}
	}
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
): vscode.LanguageModelResponsePart | undefined {
	const constructor = (
		vscode as unknown as {
			LanguageModelThinkingPart?: new (value: string) => unknown;
		}
	).LanguageModelThinkingPart;

	if (typeof constructor !== 'function') {
		return undefined;
	}

	try {
		return new constructor(text) as vscode.LanguageModelResponsePart;
	} catch (error) {
		log.warn(`Could not report reasoning: ${String(error)}`);

		return undefined;
	}
}

/**
 * The effort the user picked in the model picker.
 *
 * Per-model configuration is declared in the proposed `chatProvider` API, so it is read defensively
 * and falls back to the older free-form options bag.
 */
function readEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions,
): EffortChoice | undefined {
	const proposed = options as { modelConfiguration?: Readonly<Record<string, unknown>> };
	const chosen =
		proposed.modelConfiguration?.reasoningEffort ?? options.modelOptions?.reasoningEffort;

	return typeof chosen === 'string' ? (chosen as EffortChoice) : undefined;
}

/** Read a non-empty string out of the host-resolved provider configuration. */
function readSetting(
	configuration: Readonly<Record<string, unknown>> | undefined,
	key: string,
): string | undefined {
	const value = configuration?.[key];

	return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseInput(argumentsText: string): object {
	try {
		const parsed: unknown = JSON.parse(argumentsText);

		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		// A call whose arguments did not survive the wire cannot be run, but failing
		// here would lose the rest of an otherwise good turn.
		return {};
	}
}

async function describeFailure(response: Response): Promise<string> {
	const detail = await response.text().catch(() => '');
	const trimmed = detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
	const status = `${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`;

	return trimmed === ''
		? `The provider returned ${status}.`
		: `The provider returned ${status}: ${trimmed}`;
}
