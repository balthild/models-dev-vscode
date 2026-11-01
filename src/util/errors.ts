/** Render an unknown thrown value as a message fit for a log or a notification. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
