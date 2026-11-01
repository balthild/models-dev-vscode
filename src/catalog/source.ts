import { readFile } from 'node:fs/promises';

import { parseCatalog } from './project.ts';
import type { Catalog } from './types.ts';

/** Where the live catalog is published. */
const CATALOG_URL = 'https://models.dev/api.json';

/** Requests are abandoned after this long. */
const FETCH_TIMEOUT_MS = 15_000;

/** The catalog is a few megabytes; far more than this is not the catalog. */
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

/**
 * Read the catalog snapshot shipped with the extension.
 *
 * @param path Absolute path of the snapshot file.
 */
export async function readSnapshot(path: string): Promise<Catalog> {
	return parseCatalog(await readFile(path, 'utf8'));
}

/**
 * Download the live catalog.
 *
 * @param signal Aborted to give up early, for instance when the extension is shutting down.
 */
export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const forwardAbort = (): void => controller.abort();
	signal?.addEventListener('abort', forwardAbort, { once: true });

	try {
		const response = await fetch(CATALOG_URL, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		});
		if (!response.ok) {
			throw new Error(`GET ${CATALOG_URL} failed with ${response.status}`);
		}

		return parseCatalog(await readBody(response));
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', forwardAbort);
	}
}

/** Read a response body, refusing to buffer more than the catalog can plausibly be. */
async function readBody(response: Response): Promise<string> {
	if (response.body === null) {
		return '';
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let size = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		size += value.byteLength;
		if (size > MAX_CATALOG_BYTES) {
			await reader.cancel();
			throw new Error(`catalog exceeds ${MAX_CATALOG_BYTES} bytes`);
		}

		text += decoder.decode(value, { stream: true });
	}

	return text + decoder.decode();
}
