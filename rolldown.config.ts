import { defineConfig } from 'rolldown';

import { stripStreamingReparsePlugin } from './build/strip-streaming-reparse.ts';

// A single extension-host bundle. `vscode` is injected by the host at runtime,
// so it must stay external.
export default defineConfig({
	input: 'src/extension.ts',
	platform: 'node',
	external: ['vscode'],
	plugins: [stripStreamingReparsePlugin()],
	output: {
		file: './dist/extension.js',
		format: 'esm',
		exports: 'named',
		sourcemap: true,
		// The provider SDKs are loaded lazily, which would otherwise split the
		// output into several chunks. The extension manifest declares one entry
		// file, so everything is inlined instead.
		codeSplitting: false,
	},
});
