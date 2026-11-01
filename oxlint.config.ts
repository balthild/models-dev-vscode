import { defineConfig } from 'oxlint';

export default defineConfig({
	plugins: ['oxc', 'unicorn', 'typescript', 'import', 'node', 'promise'],
	options: {
		typeAware: true,
	},
	rules: {
		// Relative imports carry an explicit `.ts` extension so the sources run
		// unbuilt under `node --test`, which does no extension resolution. Both
		// rules below assume extension-less specifiers, so they cannot apply.
		'import/extensions': 'off',
		'import/no-relative-parent-imports': 'off',
		'import/consistent-type-specifier-style': 'warn',
		'unicorn/prefer-node-protocol': 'warn',
		'typescript/no-redundant-type-constituents': 'off',
	},
	overrides: [
		{
			files: ['test/**'],
			rules: {
				// `node:test` registers cases by calling `test()`, and the runner owns
				// the promise that call returns.
				'typescript/no-floating-promises': 'off',
			},
		},
	],
});
