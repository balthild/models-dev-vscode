import type { CatalogModel, ReasoningEffortLevel } from './types.ts';

/** An effort level that names a specific reasoning budget. */
export type NamedEffort = Exclude<ReasoningEffortLevel, 'none' | 'default'>;

/** A value offered in the model picker's reasoning submenu. */
export type EffortChoice = 'disabled' | 'enabled' | NamedEffort;

/** How a model's reasoning can be configured, in host-neutral terms. */
export interface ReasoningProfile {
	/** Whether the model reasons at all. */
	readonly supported: boolean;
	/** Effort levels to offer, lowest first, never including an off level. */
	readonly efforts: readonly NamedEffort[];
	/** Whether the user can turn reasoning off. */
	readonly canDisable: boolean;
	/** Whether reasoning is always on and cannot be turned off. */
	readonly always: boolean;
	/** Token budget bounds, when the provider expresses reasoning as a budget. */
	readonly budget?: { readonly min?: number; readonly max?: number };
	/** The choice offered as the default. */
	readonly defaultChoice: EffortChoice;
}

/**
 * Canonical low-to-high order, so a provider's unordered `values` list still yields a stable menu
 * and a stable median.
 */
const EFFORT_ORDER: readonly NamedEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * An effort value that means "do not reason", rather than naming a budget. It is deliberately
 * absent from `EFFORT_ORDER`, as is `'default'`, which asks the provider to pick and so names no
 * level of its own.
 */
const OFF_LEVEL = 'none';

/**
 * Reduce the catalog's `reasoning_options` to a profile.
 *
 * The catalog cannot say how a request actually switches reasoning off, because that differs per
 * protocol and per provider; it only says whether switching off is possible. Choosing the wire
 * representation is the request layer's job.
 */
export function deriveReasoning(
	model: Pick<CatalogModel, 'reasoning' | 'reasoning_options'>,
): ReasoningProfile {
	if (model.reasoning !== true) {
		return {
			supported: false,
			efforts: [],
			canDisable: false,
			always: false,
			defaultChoice: 'disabled',
		};
	}

	const options = model.reasoning_options ?? [];
	const hasToggle = options.some((option) => option.type === 'toggle');
	const rawValues = options.flatMap((option) => (option.type === 'effort' ? option.values : []));
	const budgetOption = options.find((option) => option.type === 'budget_tokens');

	const efforts = EFFORT_ORDER.filter((level) => rawValues.some((value) => value === level));
	// A graded list that contains an off level can be switched off through that
	// level, so it does not need a separate toggle.
	const canDisable = hasToggle || rawValues.some((value) => value === null || value === OFF_LEVEL);

	const budget =
		budgetOption?.type === 'budget_tokens'
			? { min: budgetOption.min, max: budgetOption.max }
			: undefined;

	return {
		supported: true,
		efforts,
		canDisable,
		// With no graded effort and no way to switch off, reasoning is forced on.
		always: efforts.length === 0 && !canDisable,
		...(budget === undefined ? {} : { budget }),
		defaultChoice: efforts.length === 0 ? 'enabled' : medianEffort(efforts),
	};
}

/** The values to offer in the model picker's reasoning submenu, in menu order. */
export function reasoningChoices(profile: ReasoningProfile): readonly EffortChoice[] {
	if (!profile.supported) {
		return [];
	}

	if (profile.efforts.length > 0) {
		return profile.canDisable ? ['disabled', ...profile.efforts] : profile.efforts;
	}

	return profile.always ? ['enabled'] : ['disabled', 'enabled'];
}

/** The middle of the offered levels, preferring `medium` when it is one of them. */
function medianEffort(efforts: readonly NamedEffort[]): NamedEffort {
	const medium = efforts.indexOf('medium');

	return medium === -1 ? efforts[Math.floor(efforts.length / 2)] : efforts[medium];
}
