import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseCatalog } from '../src/catalog/project.ts';

const PAYLOAD = JSON.stringify({
	example: {
		name: 'Example',
		npm: '@ai-sdk/openai-compatible',
		api: 'https://example.test/v1',
		models: {
			'model-one': {
				name: 'Model One',
				family: 'one',
				limit: { context: 1_000, output: 100 },
				modalities: { input: ['text', 'image'], output: ['text'] },
				tool_call: true,
				reasoning: true,
				reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
				// The catalog carries far more than the extension reads, including
				// fields that would be wrong to trust as-is.
				unexpected: 'not modelled',
			},
		},
	},
});

describe('parseCatalog', () => {
	test('parses a provider and its models', () => {
		const catalog = parseCatalog(PAYLOAD);

		assert.deepEqual(Object.keys(catalog), ['example']);
		assert.equal(catalog.example.name, 'Example');
		assert.equal(catalog.example.api, 'https://example.test/v1');
		assert.deepEqual(Object.keys(catalog.example.models), ['model-one']);
	});

	test('projects models onto the fields the extension reads', () => {
		const model = parseCatalog(PAYLOAD).example.models['model-one'];

		assert.equal(model.name, 'Model One');
		assert.equal(model.family, 'one');
		assert.deepEqual(model.limit, { context: 1_000, input: undefined, output: 100 });
		assert.deepEqual(model.modalities, { input: ['text', 'image'], output: ['text'] });
		assert.deepEqual(model.reasoning_options, [{ type: 'effort', values: ['low', 'high'] }]);
		assert.equal('unexpected' in model, false);
	});

	test('coerces a malformed limit to a number instead of passing it through', () => {
		const catalog = parseCatalog(
			JSON.stringify({
				example: {
					name: 'Example',
					npm: 'p',
					models: { m: { name: 'M', limit: { context: 'big', output: '100' } } },
				},
			}),
		);

		assert.deepEqual(catalog.example.models.m.limit, {
			context: 0,
			input: undefined,
			output: 0,
		});
	});

	test('keeps the payload key as the provider id when the entry omits one', () => {
		const catalog = parseCatalog(PAYLOAD);

		assert.equal(catalog.example.id, 'example');
	});

	test('drops entries that are not shaped like providers or models', () => {
		const catalog = parseCatalog(
			JSON.stringify({
				good: { name: 'Good', npm: 'p', models: { m: { name: 'M' }, broken: 42 } },
				noPackage: { name: 'No package' },
				notAnObject: 'nope',
			}),
		);

		assert.deepEqual(Object.keys(catalog), ['good']);
		assert.deepEqual(Object.keys(catalog.good.models), ['m']);
	});

	test('rejects a payload that is not an object', () => {
		assert.throws(() => parseCatalog('[]'), /not an object/);
		assert.throws(() => parseCatalog('"nope"'), /not an object/);
	});

	test('rejects a payload with no usable provider', () => {
		assert.throws(() => parseCatalog('{}'), /no usable provider/);
		// A wrapper object is the shape mistake worth naming: every entry fails to
		// look like a provider, so the load fails loudly instead of going empty.
		assert.throws(
			() => parseCatalog(JSON.stringify({ providers: { example: { name: 'x', npm: 'p' } } })),
			/no usable provider/,
		);
	});
});
