/**
 * Headless stand-in for `src/plugins/index.js`.
 *
 * The real barrel also re-exports `./components` (raw `.vue` SFC imports —
 * cannot even parse under Node) and `./sentry` / `./router` (the 629-file
 * component/view closure — see CLAUDE.md § "The store-graph problem").
 * `src/stores/settings/appearance.js:29` is the only data-layer edge that
 * reaches this file, and only for `loadLocalizedStrings`, so that is all
 * this re-exports.
 */
export * from './i18n.js';
