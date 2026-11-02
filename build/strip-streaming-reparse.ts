import type { Plugin } from 'rolldown';

/**
 * Removes pi-ai's per-delta re-parse of accumulated tool-call arguments while bundling.
 *
 * Each stream adapter runs `block.arguments = parseStreamingJson(accumulated)` on every delta, so
 * the arguments received so far are parsed from their first byte again, once per delta: quadratic
 * in the size of the arguments, and synchronous, so it blocks the extension host. A tool call
 * writing a 100 KB file costs about 1.7 s, and one writing 1 MB about 200 s (measured on 1.4.0 with
 * 32-character deltas).
 *
 * The result is dead. Tool-call blocks are created with `arguments: {}` and finishing the call
 * overwrites the field with the parse of the complete text (`parseToolCallArguments`), so all this
 * removal changes is what `AssistantMessageEvent.partial` reports mid-stream: `{}` instead of a
 * partial parse. We read `partial` only for thinking blocks, whose signatures it carries.
 *
 * Bundling is the only seam available: an adapter imports `parseStreamingJson` as a module binding,
 * so it cannot be replaced from the outside, and patching `node_modules` would tie the patch to one
 * exact version and one package manager. Upstream is earendil-works/pi#9265, still open in 1.4.0
 * (the newest release as of 2026-11-02). Every statement is matched as written in the installed
 * source, so an upgrade that moves or renames a call site fails the build rather than quietly
 * restoring the cost.
 */
const PI_AI_MODULE = /[/\\]node_modules[/\\]@earendil-works[/\\]pi-ai[/\\]/;

/** Defines the helper rather than calling it. */
const DEFINITION_MODULE = 'dist/utils/json-parse.js';

/**
 * Statements to delete, keyed by path within the package. A module that calls `parseStreamingJson`
 * without an entry here fails the build, so bundling another adapter is a deliberate act.
 */
const REMOVALS = new Map<string, RegExp>([
	[
		'dist/api/anthropic-messages.js',
		/^[ \t]*block\.arguments = parseStreamingJson\(block\.partialJson\);[ \t]*\r?\n/gm,
	],
	[
		'dist/api/openai-completions.js',
		/^[ \t]*block\.arguments = parseStreamingJson\(block\.partialArgs\);[ \t]*\r?\n/gm,
	],
	[
		'dist/api/openai-responses-shared.js',
		/^[ \t]*slot\.block\.arguments = parseStreamingJson\(slot\.block\.partialJson\);[ \t]*\r?\n/gm,
	],
]);

/** The path of `id` within pi-ai, or `undefined` when it belongs to another package. */
function moduleWithin(id: string): string | undefined {
	const found = PI_AI_MODULE.exec(id);
	return found === null ? undefined : id.slice(found.index + found[0].length).replaceAll('\\', '/');
}

/**
 * Strips the per-delta parse out of one module's source, or returns `undefined` when the module has
 * none. Throws when pi-ai calls `parseStreamingJson` somewhere this patch does not know about.
 */
export function stripStreamingReparse(id: string, code: string): string | undefined {
	const module = moduleWithin(id);
	if (
		module === undefined ||
		module === DEFINITION_MODULE ||
		!code.includes('parseStreamingJson(')
	) {
		return undefined;
	}

	const statement = REMOVALS.get(module);
	if (statement === undefined) {
		throw new Error(`${module} calls parseStreamingJson; add its statement to REMOVALS`);
	}

	const stripped = code.replace(statement, '');
	const leftover = stripped.indexOf('parseStreamingJson(');
	if (leftover !== -1) {
		const line = stripped.slice(0, leftover).split('\n').length;
		throw new Error(`${module}:${line} calls parseStreamingJson; add its statement to REMOVALS`);
	}

	return stripped;
}

export function stripStreamingReparsePlugin(): Plugin {
	return {
		name: 'strip-streaming-reparse',
		transform(code, id) {
			const stripped = stripStreamingReparse(id, code);
			// Whole lines are removed, so the incoming map no longer describes the result, and
			// `null` is how a plugin says so without asking for a warning.
			return stripped === undefined ? undefined : { code: stripped, map: null };
		},
	};
}
