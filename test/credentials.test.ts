import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { credentialsOf, readSetting } from '#/provider/credentials.ts';

describe('credentialsOf', () => {
	test('reads the key the host resolved', () => {
		assert.deepEqual(credentialsOf({ apiKey: 'sk-1' }), { apiKey: 'sk-1' });
	});

	test('carries an endpoint override when one was given', () => {
		assert.deepEqual(credentialsOf({ apiKey: 'sk-1', baseUrl: 'https://proxy.test/v1' }), {
			apiKey: 'sk-1',
			baseUrl: 'https://proxy.test/v1',
		});
	});

	test('reports nothing before the user has added the provider', () => {
		// The host sends no configuration for a provider still sitting in the Add Provider menu.
		assert.equal(credentialsOf(undefined), undefined);
		assert.equal(credentialsOf({}), undefined);
	});

	test('reports nothing for a key that is present but blank', () => {
		assert.equal(credentialsOf({ apiKey: '' }), undefined);
		assert.equal(credentialsOf({ apiKey: '   ' }), undefined);
	});

	test('trims a pasted key, which would otherwise carry its whitespace to the provider', () => {
		assert.deepEqual(credentialsOf({ apiKey: ' sk-1\n' }), { apiKey: 'sk-1' });
	});

	test('ignores an empty endpoint override instead of sending an empty base URL', () => {
		assert.deepEqual(credentialsOf({ apiKey: 'sk-1', baseUrl: '' }), { apiKey: 'sk-1' });
	});

	test('survives a configuration that is not an object', () => {
		assert.equal(credentialsOf('sk-1'), undefined);
		assert.equal(credentialsOf(['sk-1']), undefined);
		assert.equal(credentialsOf(42), undefined);
	});

	test('ignores values of the wrong type', () => {
		assert.equal(credentialsOf({ apiKey: 42 }), undefined);
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
