/**
 * Names the host and the manifest both have to agree on.
 *
 * The manifest is hand-written, so `test/manifest.test.ts` is what keeps these in step with it.
 * Kept out of `commands.ts` because the chat provider starts the add flow itself when the host asks
 * it to configure the vendor, and going through `commands.ts` would make the two import each
 * other.
 */

/** The one vendor this extension registers with the host. */
export const VENDOR_ID = 'modelsdev';

/**
 * Group setting naming the models.dev provider a group serves.
 *
 * The host hands a provider neither the group nor its name, so this setting is the only thing that
 * says which upstream a listing belongs to.
 */
export const PROVIDER_SETTING = 'provider';

/** Commands the extension registers, which the manifest has to declare. */
export const COMMANDS = {
	/**
	 * Named in the manifest as the vendor's `managementCommand`, which is what makes the host hand
	 * Add Models to the provider rather than run its own wizard. The wizard stays declared through
	 * `configuration`, so it remains a way in if that ever stops working.
	 */
	addProvider: 'modelsdev.addProvider',
	updateData: 'modelsdev.updateData',
	showStatus: 'modelsdev.showStatus',
} as const;
