import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deriveModel, deriveProviderModels } from '#/catalog/derive.ts';
import { resolveProtocol } from '#/catalog/protocol.ts';
import { deriveReasoning, reasoningChoices } from '#/catalog/reasoning.ts';
import type { CatalogModel, CatalogProvider } from '#/catalog/types.ts';

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
	return { id: 'm', name: 'M', limit: { context: 1_000, output: 100 }, ...overrides };
}

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
	return {
		id: 'p',
		name: 'P',
		npm: '@ai-sdk/openai-compatible',
		api: 'https://example.test/v1',
		models: {},
		...overrides,
	};
}

describe('resolveProtocol', () => {
	test('maps the OpenAI packages to chat completions', () => {
		assert.equal(resolveProtocol('@ai-sdk/openai', undefined), 'chatCompletions');
		assert.equal(resolveProtocol('@ai-sdk/openai-compatible', undefined), 'chatCompletions');
	});

	test('maps the Anthropic package to messages', () => {
		assert.equal(resolveProtocol('@ai-sdk/anthropic', undefined), 'messages');
	});

	test('selects the Responses API for the responses shape', () => {
		assert.equal(resolveProtocol('@ai-sdk/openai', 'responses'), 'responses');
	});

	test('ignores the responses shape on a package without that surface', () => {
		assert.equal(resolveProtocol('@ai-sdk/anthropic', 'responses'), 'messages');
	});

	test('rejects packages whose credentials it cannot collect', () => {
		const unsupported = [
			'@ai-sdk/google',
			'@ai-sdk/google-vertex',
			'@ai-sdk/amazon-bedrock',
			'@ai-sdk/azure',
		];

		for (const npm of unsupported) {
			assert.equal(resolveProtocol(npm, undefined), undefined, npm);
		}
	});

	test('rejects a model with no package at all', () => {
		assert.equal(resolveProtocol(undefined, undefined), undefined);
	});
});

describe('deriveReasoning', () => {
	test('reports nothing selectable for a plain model', () => {
		const profile = deriveReasoning({ reasoning: false });

		assert.equal(profile.supported, false);
		assert.deepEqual(reasoningChoices(profile), []);
	});

	test('treats a reasoning model with no options as always on', () => {
		const profile = deriveReasoning({ reasoning: true });

		assert.equal(profile.always, true);
		assert.equal(profile.canDisable, false);
		assert.deepEqual(reasoningChoices(profile), ['enabled']);
	});

	test('treats a bare toggle as on or off', () => {
		const profile = deriveReasoning({ reasoning: true, reasoning_options: [{ type: 'toggle' }] });

		assert.equal(profile.always, false);
		assert.equal(profile.canDisable, true);
		assert.deepEqual(reasoningChoices(profile), ['disabled', 'enabled']);
	});

	test('orders graded efforts from lowest to highest', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['max', 'low', 'high'] }],
		});

		assert.deepEqual(profile.efforts, ['low', 'high', 'max']);
	});

	test('defaults to medium when it is offered', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
		});

		assert.equal(profile.defaultChoice, 'medium');
	});

	test('defaults to the middle of the offered levels otherwise', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
		});

		assert.equal(profile.defaultChoice, 'high');
	});

	test('offers an explicit off level as disabled rather than a level', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
		});

		assert.equal(profile.canDisable, true);
		assert.deepEqual(profile.efforts, ['low', 'high']);
		assert.deepEqual(reasoningChoices(profile), ['disabled', 'low', 'high']);
	});

	test('reads a null level as an off switch', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: [null, 'low', 'high'] }],
		});

		assert.equal(profile.canDisable, true);
		assert.deepEqual(reasoningChoices(profile), ['disabled', 'low', 'high']);
	});

	test('keeps a graded list with no off level unswitchable', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['high'] }],
		});

		assert.equal(profile.canDisable, false);
		assert.equal(profile.always, false);
		assert.deepEqual(reasoningChoices(profile), ['high']);
	});

	test('treats the provider default level as neither a level nor an off switch', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'effort', values: ['default', 'high'] }],
		});

		assert.equal(profile.canDisable, false);
		assert.deepEqual(profile.efforts, ['high']);
	});

	test('carries the token budget bounds', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'budget_tokens', min: 1_024, max: 32_000 }],
		});

		assert.deepEqual(profile.budget, { min: 1_024, max: 32_000 });
		assert.equal(profile.always, true);
	});

	test('combines a toggle with a budget', () => {
		const profile = deriveReasoning({
			reasoning: true,
			reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', max: 32_000 }],
		});

		assert.deepEqual(profile.budget, { min: undefined, max: 32_000 });
		assert.deepEqual(reasoningChoices(profile), ['disabled', 'enabled']);
	});
});

describe('deriveModel', () => {
	test('maps the catalog limits onto the token budget', () => {
		const derived = deriveModel({
			provider: provider(),
			model: model({ limit: { context: 200_000, input: 150_000, output: 50_000 } }),
		});

		assert.equal(derived?.contextWindow, 200_000);
		assert.equal(derived?.maxInputTokens, 150_000);
		assert.equal(derived?.maxOutputTokens, 50_000);
	});

	test('derives the input cap from the window when the catalog omits it', () => {
		const derived = deriveModel({
			provider: provider(),
			model: model({ limit: { context: 1_000, output: 200 } }),
		});

		assert.equal(derived?.maxInputTokens, 800);
	});

	test('prefers a model-specific endpoint over the provider default', () => {
		const derived = deriveModel({
			provider: provider({ api: 'https://provider.test/v1' }),
			model: model({ provider: { api: 'https://model.test/v1' } }),
		});

		assert.equal(derived?.baseUrl, 'https://model.test/v1');
	});

	test('falls back to the provider package for the protocol', () => {
		const derived = deriveModel({
			provider: provider({ npm: '@ai-sdk/anthropic' }),
			model: model(),
		});

		assert.equal(derived?.protocol, 'messages');
	});

	test('rejects a model with no output budget', () => {
		const derived = deriveModel({
			provider: provider(),
			model: model({ limit: { context: 1_000, output: 0 } }),
		});

		assert.equal(derived, undefined);
	});

	test('rejects a model that produces no text', () => {
		const derived = deriveModel({
			provider: provider(),
			model: model({ modalities: { input: ['text'], output: ['image'] } }),
		});

		assert.equal(derived, undefined);
	});

	test('rejects a model whose type is not chat', () => {
		assert.equal(
			deriveModel({ provider: provider(), model: model({ type: 'embedding' }) }),
			undefined,
		);
	});

	test('rejects a deprecated model', () => {
		assert.equal(
			deriveModel({ provider: provider(), model: model({ status: 'deprecated' }) }),
			undefined,
		);
	});

	test('rejects a model on a protocol it cannot speak', () => {
		const derived = deriveModel({
			provider: provider({ npm: '@ai-sdk/google' }),
			model: model(),
		});

		assert.equal(derived, undefined);
	});

	test('rejects a provider with no endpoint', () => {
		assert.equal(
			deriveModel({ provider: provider({ api: undefined }), model: model() }),
			undefined,
		);
	});

	test('reads capabilities from the catalog', () => {
		const derived = deriveModel({
			provider: provider(),
			model: model({ modalities: { input: ['text', 'image'], output: ['text'] }, tool_call: true }),
		});

		assert.equal(derived?.imageInput, true);
		assert.equal(derived?.toolCalling, true);
	});

	test('defaults capabilities to off when the catalog is silent', () => {
		const derived = deriveModel({ provider: provider(), model: model() });

		assert.equal(derived?.imageInput, false);
		assert.equal(derived?.toolCalling, false);
	});
});

describe('deriveProviderModels', () => {
	test('drops unservable models and orders the rest by id', () => {
		const derived = deriveProviderModels(
			provider({
				models: {
					zebra: model({ id: 'zebra' }),
					alpha: model({ id: 'alpha' }),
					dead: model({ id: 'dead', limit: { context: 1_000, output: 0 } }),
				},
			}),
		);

		assert.deepEqual(
			derived.map((entry) => entry.id),
			['alpha', 'zebra'],
		);
	});
});
