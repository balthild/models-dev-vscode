import * as vscode from 'vscode';

import {
	DEFAULT_ENABLED_PROVIDERS,
	HARD_DISABLED_PROVIDERS,
	isShippedProvider,
} from '../catalog/providers.ts';

const SECTION = 'modelsdev';
const PROVIDERS_KEY = 'providers';

/**
 * Providers the user has switched on.
 *
 * The result is filtered rather than validated: an unknown id, or one whose provider VS Code
 * already serves, is dropped instead of reported, so a stale setting cannot put a duplicate in the
 * picker.
 */
export function enabledProviders(): readonly string[] {
	const configured = vscode.workspace.getConfiguration(SECTION).get<string[]>(PROVIDERS_KEY);

	return (configured ?? DEFAULT_ENABLED_PROVIDERS).filter(
		(id) => isShippedProvider(id) && !HARD_DISABLED_PROVIDERS.has(id),
	);
}

/** Run the listener whenever the enabled providers change. */
export function onDidChangeProviders(listener: () => void): vscode.Disposable {
	return vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration(`${SECTION}.${PROVIDERS_KEY}`)) {
			listener();
		}
	});
}
