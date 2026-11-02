import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripStreamingReparse } from '#build/strip-streaming-reparse.ts';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai')));

function moduleId(file: string): string {
	return join(dist, 'api', file);
}

function source(file: string): string {
	return readFileSync(moduleId(file), 'utf8');
}

function blankLines(code: string): number {
	return code.split('\n').filter((line) => line.trim() === '').length;
}

const ADAPTERS = [
	{
		file: 'anthropic-messages.js',
		accumulates: 'block.partialJson += event.delta.partial_json;',
	},
	{
		file: 'openai-completions.js',
		accumulates: 'block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;',
	},
	{
		file: 'openai-responses-shared.js',
		accumulates: 'slot.block.partialJson += event.delta;',
	},
];

describe('stripStreamingReparse', () => {
	for (const adapter of ADAPTERS) {
		test(`strips the per-delta parse out of ${adapter.file}`, () => {
			const code = source(adapter.file);
			assert.ok(
				code.includes('parseStreamingJson('),
				'the installed adapter should call the helper',
			);

			const stripped = stripStreamingReparse(moduleId(adapter.file), code);

			assert.ok(stripped !== undefined, 'the adapter should have been patched');
			assert.ok(!stripped.includes('parseStreamingJson('), 'the per-delta parse should be gone');
			assert.ok(
				stripped.includes('parseToolCallArguments('),
				'the parse of the finished text remains',
			);
			assert.ok(stripped.includes(adapter.accumulates), 'the accumulator remains');
			assert.equal(blankLines(stripped), blankLines(code), 'no emptied line may be left behind');
		});
	}

	test('refuses a call site it has no policy for', () => {
		const file = 'mistral-conversations.js';

		assert.throws(
			() => stripStreamingReparse(moduleId(file), source(file)),
			/add its statement to REMOVALS/,
		);
	});

	test('leaves the module that defines the helper alone', () => {
		const id = join(dist, 'utils', 'json-parse.js');

		assert.equal(stripStreamingReparse(id, readFileSync(id, 'utf8')), undefined);
	});

	test('leaves modules outside pi-ai alone', () => {
		assert.equal(
			stripStreamingReparse('/extension/src/provider/request.ts', 'parseStreamingJson(x);'),
			undefined,
		);
	});
});
