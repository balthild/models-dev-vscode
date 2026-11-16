import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { credentialsOf, readSetting } from '#/provider/credentials.ts';

describe('credentialsOf', () => {
	test('reads the provider and key the host resolved', () => {
		assert.deepEqual(credentialsOf({ provider: 'deepseek', apiKey: 'sk-1' }), {
			provider: 'deepseek',
			apiKey: 'sk-1',
		});
	});

	test('carries an endpoint override when one was given', () => {
		assert.deepEqual(
			credentialsOf({ provider: 'deepseek', apiKey: 'sk-1', baseUrl: 'https://proxy.test/v1' }),
			{ provider: 'deepseek', apiKey: 'sk-1', baseUrl: 'https://proxy.test/v1' },
		);
	});

	test('reports nothing before the user has added a group', () => {
		// The host sends no configuration for a vendor still sitting in the Add Provider menu.
		assert.equal(credentialsOf(undefined), undefined);
		assert.equal(credentialsOf({}), undefined);
	});

	test('reports nothing for a group that names no provider', () => {
		// Without a provider there is no model list, so a key alone cannot make a group usable.
		assert.equal(credentialsOf({ apiKey: 'sk-1' }), undefined);
		assert.equal(credentialsOf({ provider: '', apiKey: 'sk-1' }), undefined);
		assert.equal(credentialsOf({ provider: '   ', apiKey: 'sk-1' }), undefined);
	});

	test('reports nothing for a key that is present but blank', () => {
		assert.equal(credentialsOf({ provider: 'deepseek', apiKey: '' }), undefined);
		assert.equal(credentialsOf({ provider: 'deepseek', apiKey: '   ' }), undefined);
	});

	test('trims a pasted key, which would otherwise carry its whitespace to the provider', () => {
		assert.deepEqual(credentialsOf({ provider: 'deepseek', apiKey: ' sk-1\n' }), {
			provider: 'deepseek',
			apiKey: 'sk-1',
		});
	});

	test('ignores an empty endpoint override instead of sending an empty base URL', () => {
		assert.deepEqual(credentialsOf({ provider: 'deepseek', apiKey: 'sk-1', baseUrl: '' }), {
			provider: 'deepseek',
			apiKey: 'sk-1',
		});
	});

	test('survives a configuration that is not an object', () => {
		assert.equal(credentialsOf('sk-1'), undefined);
		assert.equal(credentialsOf(['sk-1']), undefined);
		assert.equal(credentialsOf(42), undefined);
	});

	test('ignores values of the wrong type', () => {
		assert.equal(credentialsOf({ provider: 'deepseek', apiKey: 42 }), undefined);
		assert.equal(credentialsOf({ provider: 42, apiKey: 'sk-1' }), undefined);
	});
});

describe('readSetting', () => {
	test('reads a non-empty string', () => {
		assert.equal(readSetting({ k: 'v' }, 'k'), 'v');
	});

	test('reports nothing for a missing, empty or non-string value', () => {
		assert.equal(readSetting({}, 'k'), undefined);
		assert.equal(readSetting({ k: '' }, 'k'), undefined);
		assert.equal(readSetting({ k: ' ' }, 'k'), undefined);
		assert.equal(readSetting({ k: 42 }, 'k'), undefined);
	});
});
