/**
 * Downloads the BPE ranks file the tokenizer counts with.
 *
 * Run with `yarn ranks`. The file is committed so a fresh clone, and the packaged extension, work
 * without network access; this script exists so it can be reproduced and its contents verified
 * rather than being an opaque blob.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken';
const OUTPUT = fileURLToPath(new URL('../assets/o200k_base.tiktoken', import.meta.url));

/** The digest OpenAI publishes alongside the file, in base64. */
const EXPECTED_SHA256 = 'RGqVOMtsNI41FhINfAiwn1fDZJXirP/+WaW/iwz7Gi0=';

main().catch((error: unknown) => {
	console.error(`ranks: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const check = process.argv.includes('--check');

	const bytes = check
		? await readFile(OUTPUT)
		: new Uint8Array(await (await fetchFile()).arrayBuffer());

	const digest = createHash('sha256').update(bytes).digest('base64');
	if (digest !== EXPECTED_SHA256) {
		throw new Error(`checksum mismatch: expected ${EXPECTED_SHA256}, got ${digest}`);
	}

	if (check) {
		console.log(`ranks: up to date (${bytes.byteLength} bytes)`);

		return;
	}

	await mkdir(dirname(OUTPUT), { recursive: true });
	await writeFile(OUTPUT, bytes);
	console.log(`ranks: wrote ${bytes.byteLength} bytes`);
}

async function fetchFile(): Promise<Response> {
	const response = await fetch(SOURCE);
	if (!response.ok) {
		throw new Error(`GET ${SOURCE} failed with ${response.status}`);
	}

	return response;
}
