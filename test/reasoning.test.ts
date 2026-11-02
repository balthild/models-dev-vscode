import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
	REASONING_METADATA,
	reasoningMetadata,
	thinkingFromMetadata,
	toThinkingLevel,
} from '#/provider/reasoning.ts';

describe('toThinkingLevel', () => {
	test('names the level a graded effort asks for', () => {
		assert.equal(toThinkingLevel('high'), 'high');
		assert.equal(toThinkingLevel('minimal'), 'minimal');
		assert.equal(toThinkingLevel('max'), 'max');
	});

	test('turns an off switch into an absent level', () => {
		// The library reads absence as "off"; naming a level would turn reasoning on instead.
		assert.equal(toThinkingLevel('disabled'), undefined);
		assert.equal(toThinkingLevel(undefined), undefined);
	});

	test('names a level for "thinking", which is not itself a level', () => {
		assert.equal(toThinkingLevel('enabled'), 'medium');
	});
});

describe('reasoningMetadata', () => {
	test('carries the text and the opaque state', () => {
		assert.deepEqual(reasoningMetadata({ thinking: 'weighing', thinkingSignature: 'sig' }), {
			[REASONING_METADATA.signature]: 'sig',
			[REASONING_METADATA.complete]: 'weighing',
		});
	});

	test('marks withheld text by which key carries the payload', () => {
		// A redacted block has no readable text, so the payload stands in for it.
		assert.deepEqual(
			reasoningMetadata({ thinking: '', thinkingSignature: 'opaque', redacted: true }),
			{ [REASONING_METADATA.redacted]: 'opaque' },
		);
	});

	test('leaves out empty text, which adds nothing to a replay', () => {
		assert.deepEqual(reasoningMetadata({ thinking: '', thinkingSignature: 'sig' }), {
			[REASONING_METADATA.signature]: 'sig',
		});
	});

	test('produces nothing for a block with no state at all', () => {
		assert.equal(reasoningMetadata({ thinking: 'just text' }), undefined);
		assert.equal(reasoningMetadata({ thinking: 'text', thinkingSignature: '' }), undefined);
	});
});

describe('thinkingFromMetadata', () => {
	test('rebuilds a signed block', () => {
		assert.deepEqual(
			thinkingFromMetadata({
				[REASONING_METADATA.signature]: 'sig',
				[REASONING_METADATA.complete]: 'weighing',
			}),
			{ type: 'thinking', thinking: 'weighing', thinkingSignature: 'sig' },
		);
	});

	test('rebuilds a withheld block, payload included', () => {
		assert.deepEqual(thinkingFromMetadata({ [REASONING_METADATA.redacted]: 'opaque' }), {
			type: 'thinking',
			thinking: '',
			thinkingSignature: 'opaque',
			redacted: true,
		});
	});

	test('drops a block with no proof it came from the model', () => {
		assert.equal(
			thinkingFromMetadata({ [REASONING_METADATA.complete]: 'display text' }),
			undefined,
		);
		assert.equal(thinkingFromMetadata({}), undefined);
		assert.equal(thinkingFromMetadata(undefined), undefined);
		assert.equal(thinkingFromMetadata('nope'), undefined);
	});

	test('ignores metadata values that are not strings', () => {
		assert.equal(thinkingFromMetadata({ [REASONING_METADATA.signature]: 42 }), undefined);
	});
});

describe('round trip', () => {
	test('a signed block survives being reported to the host and handed back', () => {
		const block = { type: 'thinking' as const, thinking: 'weighing', thinkingSignature: 'sig' };

		// What the provider reports, then what the host hands back on the next turn.
		const metadata = reasoningMetadata(block);
		const replayed = thinkingFromMetadata(metadata);

		assert.deepEqual(replayed, block);
	});

	test('a withheld block survives the same round trip', () => {
		const block = {
			type: 'thinking' as const,
			thinking: '',
			thinkingSignature: 'opaque',
			redacted: true,
		};

		assert.deepEqual(thinkingFromMetadata(reasoningMetadata(block)), block);
	});
});
