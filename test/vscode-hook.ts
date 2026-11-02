/**
 * Resolves the `vscode` specifier to the stub while running tests.
 *
 * The extension is loaded with the real module injected by the host, and Node has no such module,
 * so every import of it has to be routed elsewhere. Registered before the test files are loaded,
 * through the `--import` flag in the `test` script.
 */
import { registerHooks } from 'node:module';

const stub = new URL('./vscode-stub.ts', import.meta.url).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		return specifier === 'vscode'
			? { url: stub, shortCircuit: true }
			: nextResolve(specifier, context);
	},
});
