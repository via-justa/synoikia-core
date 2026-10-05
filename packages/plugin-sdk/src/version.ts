/** Version of the plugin contract implemented by this SDK. Plugins declare a compatible range in `manifest.sdk`. */
export const SDK_VERSION = '0.2.2';

/**
 * The contract version from which core applies an operation's `sensitiveResult` itself (design §5.5).
 * A plugin that declares `sensitiveResult` must require at least this in `manifest.sdk`: an older core
 * drops the field, and the result would reach the model unmasked.
 */
export const SENSITIVE_RESULT_SINCE = '0.2.2';
