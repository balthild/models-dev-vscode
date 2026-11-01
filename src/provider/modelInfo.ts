import type * as vscode from 'vscode';

import type { NeutralModel } from '#/catalog/derive.ts';
import type { EffortChoice, ReasoningProfile } from '#/catalog/reasoning.ts';
import { reasoningChoices } from '#/catalog/reasoning.ts';

/**
 * Fields the language model provider API accepts but that the published typings do not yet declare,
 * because they live in the proposed `chatProvider` API.
 *
 * They are read back by the host straight off the returned object, so setting them needs no
 * proposed-API opt-in; only _typing_ them does.
 */
interface ProposedModelInformation {
	/**
	 * The true context window. Without it the host shows input plus output maxima as the window,
	 * which overstates it for every model whose maxima do not add up.
	 */
	readonly maxContextWindowTokens?: number;
	/** Options offered in the model picker's configuration submenu. */
	readonly configurationSchema?: {
		readonly properties?: Readonly<Record<string, unknown>>;
	};
}

export type ModelInformation = vscode.LanguageModelChatInformation & ProposedModelInformation;

/** Project a catalog model onto the model picker entry. */
export function toModelInformation(model: NeutralModel): ModelInformation {
	const choices = reasoningChoices(model.reasoning);

	return {
		id: model.id,
		name: model.name,
		family: model.family,
		version: model.version,
		tooltip: model.description,
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
		maxContextWindowTokens: model.contextWindow,
		capabilities: {
			imageInput: model.imageInput,
			toolCalling: model.toolCalling,
		},
		...(choices.length === 0
			? {}
			: {
					configurationSchema: {
						properties: { reasoningEffort: reasoningProperty(choices, model.reasoning) },
					},
				}),
	};
}

/**
 * The reasoning submenu descriptor.
 *
 * `group: 'navigation'` is what surfaces it as a primary action next to the model rather than
 * behind a settings page.
 */
function reasoningProperty(
	choices: readonly EffortChoice[],
	profile: ReasoningProfile,
): Record<string, unknown> {
	return {
		type: 'string',
		title: 'Reasoning Effort',
		enum: choices,
		enumItemLabels: choices.map(label),
		enumDescriptions: choices.map(describe),
		default: profile.defaultChoice,
		group: 'navigation',
	};
}

function label(choice: EffortChoice): string {
	switch (choice) {
		case 'disabled':
			return 'Disabled';
		case 'enabled':
			return 'Thinking';
		case 'xhigh':
			return 'Extra high';
		case 'max':
			return 'Maximum';
		default:
			return choice.charAt(0).toUpperCase() + choice.slice(1);
	}
}

function describe(choice: EffortChoice): string {
	switch (choice) {
		case 'disabled':
			return 'Do not reason before answering';
		case 'enabled':
			return 'Reason at the level the model picks';
		case 'minimal':
			return 'Least reasoning, fastest response';
		case 'low':
			return 'Little reasoning, fast response';
		case 'medium':
			return 'Balance reasoning against speed';
		case 'high':
			return 'More reasoning, slower response';
		case 'xhigh':
			return 'Very deep reasoning, slower response';
		case 'max':
			return 'Deepest reasoning, slowest response';
		default:
			return choice;
	}
}
