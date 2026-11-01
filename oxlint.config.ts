import { defineConfig } from 'oxlint';

export default defineConfig({
	plugins: ['oxc', 'unicorn', 'typescript', 'import', 'node', 'promise'],
	options: {
		typeAware: true,
	},
	rules: {
		'import/extensions': ['error', 'ignorePackages'],
		'import/no-relative-parent-imports': 'warn',
		'import/consistent-type-specifier-style': 'warn',
		'unicorn/prefer-node-protocol': 'warn',
		'typescript/no-redundant-type-constituents': 'off',
	},
	overrides: [
		{
			files: ['test/**'],
			rules: {
				'typescript/no-floating-promises': 'off',
			},
		},
	],
});
