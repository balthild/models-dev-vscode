import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { NeutralModel } from '../src/catalog/derive.ts';
import { deriveReasoning } from '../src/catalog/reasoning.ts';
import { toModelInformation } from '../src/provider/modelInfo.ts';

function model(overrides: Partial<NeutralModel> = {}): NeutralModel {
	return {
		id: 'model',
		name: 'Model',
		description: 'A model',
		family: 'family',
		version: '2026-01-01',
		protocol: 'chatCompletions',
		baseUrl: 'https://example.test/v1',
		contextWindow: 100_000,
		maxInputTokens: 90_000,
		maxOutputTokens: 10_000,
		imageInput: true,
		toolCalling: true,
		reasoning: deriveReasoning({ reasoning: false }),
		...overrides,
	};
}

/** The reasoning submenu descriptor, which the typings do not yet declare. */
function reasoningProperty(information: ReturnType<typeof toModelInformation>) {
	const schema = (
		information as {
			configurationSchema?: { properties?: Record<string, Record<string, unknown>> };
		}
	).configurationSchema;

	return schema?.properties?.reasoningEffort;
}

describe('toModelInformation', () => {
	test('carries the catalog identity and budget', () => {
		const information = toModelInformation(model());

		assert.equal(information.id, 'model');
		assert.equal(information.name, 'Model');
		assert.equal(information.family, 'family');
		assert.equal(information.version, '2026-01-01');
		assert.equal(information.maxInputTokens, 90_000);
		assert.equal(information.maxOutputTokens, 10_000);
	});

	test('reports the context window rather than the sum of the maxima', () => {
		const information = toModelInformation(model());

		assert.equal(
			(information as { maxContextWindowTokens?: number }).maxContextWindowTokens,
			100_000,
		);
	});

	test('carries the capabilities through', () => {
		const information = toModelInformation(model({ imageInput: false, toolCalling: false }));

		assert.deepEqual(information.capabilities, { imageInput: false, toolCalling: false });
	});

	test('offers no reasoning menu for a model that does not reason', () => {
		assert.equal(reasoningProperty(toModelInformation(model())), undefined);
	});

	test('offers the graded efforts in order, with matching labels', () => {
		const information = toModelInformation(
			model({
				reasoning: deriveReasoning({
					reasoning: true,
					reasoning_options: [{ type: 'effort', values: ['high', 'low'] }],
				}),
			}),
		);
		const property = reasoningProperty(information);

		const descriptions = property?.enumDescriptions as string[] | undefined;

		assert.deepEqual(property?.enum, ['low', 'high']);
		assert.deepEqual(property?.enumItemLabels, ['Low', 'High']);
		assert.equal(descriptions?.length, 2);
		// The middle of the offered levels, which for two levels is the higher one.
		assert.equal(property?.default, 'high');
	});

	test('offers an off switch when the model can be switched off', () => {
		const information = toModelInformation(
			model({
				reasoning: deriveReasoning({ reasoning: true, reasoning_options: [{ type: 'toggle' }] }),
			}),
		);
		const property = reasoningProperty(information);

		assert.deepEqual(property?.enum, ['disabled', 'enabled']);
		assert.deepEqual(property?.enumItemLabels, ['Disabled', 'Thinking']);
	});

	test('surfaces the menu as a primary action', () => {
		const information = toModelInformation(
			model({
				reasoning: deriveReasoning({ reasoning: true, reasoning_options: [{ type: 'toggle' }] }),
			}),
		);

		assert.equal(reasoningProperty(information)?.group, 'navigation');
	});
});
