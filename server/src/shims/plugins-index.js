/**
 * Headless stand-in for `src/plugins/index.js`.
 *
 * The real barrel also re-exports `./components` (raw `.vue` SFC imports —
 * cannot even parse under Node) and `./sentry` / `./router` (the 629-file
 * component/view closure — see CLAUDE.md § "The store-graph problem").
 * Two data-layer edges reach this file: `src/stores/settings/appearance.js`
 * for `loadLocalizedStrings`, and `src/stores/index.js` (the real barrel,
 * phase 2b step 4) for `getSentry`/`isSentryOptedIn`.
 */
export * from './i18n.js';

/**
 * `NIGHTLY` is always false on the server (`server/src/globals.js`), so the
 * real implementations are `NIGHTLY && …` / `NIGHTLY ? … : null` — always
 * false/null here too. Reimplemented rather than re-exported from the real
 * `src/plugins/sentry.js` to keep this shim's own import graph fixed, even
 * though that file happens to be safe to import today (its `./router` edge
 * is aliased already).
 */
export async function isSentryOptedIn() {
    return false;
}

/** @returns {null} */
export function getSentry() {
    return null;
}
