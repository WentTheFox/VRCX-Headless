/**
 * Headless stand-in for `src/localization/index.js`.
 *
 * The real module calls `import.meta.glob('./*.json', …)` twice, at module
 * scope, to eagerly enumerate every locale JSON file — Vite-only syntax,
 * fails immediately under Node regardless of which export a caller actually
 * wants (`src/stores/settings/advanced.js` only needs the static
 * `languageCodes` array).
 *
 * `languageCodes` itself lives in the real, Vite-free `./locales.js` (kept
 * separate upstream specifically so `vite.config.js` can import it too), so
 * that part is re-exported for real rather than duplicated. The two
 * functions that actually read locale JSON content (`getLocalizedStrings`,
 * `getLanguageName`) have no reachable caller in the server closure today —
 * the only thing that wanted them, `src/plugins/i18n.js`, is aliased away
 * entirely — so they're cheap passthrough stubs, not full reimplementations.
 */
export { languageCodes } from '../../../src/localization/locales.js';

/**
 * @param {string} _code
 * @returns {Promise<object>}
 */
export async function getLocalizedStrings(_code) {
    return {};
}

/**
 * @param {string} code
 * @returns {string}
 */
export function getLanguageName(code) {
    return code;
}

/**
 * @param {string} systemLanguage
 * @param {string[]} codes
 * @returns {string | null}
 */
export function resolveSystemLanguage(systemLanguage, codes) {
    if (!systemLanguage) return null;
    if (codes.includes(systemLanguage)) return systemLanguage;
    const lang = systemLanguage.split('-')[0];
    return codes.find((code) => code.split('-')[0] === lang) ?? null;
}
