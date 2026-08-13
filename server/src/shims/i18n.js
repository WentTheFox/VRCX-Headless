/**
 * Headless stand-in for `src/plugins/i18n.js`.
 *
 * The real module builds a vue-i18n instance and eagerly imports every locale
 * bundle. The data layer only ever reaches `i18n.global.t(key)` to label a
 * dialog, and the server has no UI, so translation keys are passed through
 * verbatim — they end up in logs, where the key is more useful than the prose.
 */
export const i18n = {
    global: {
        /**
         * @param {string} key
         * @returns {string}
         */
        t(key) {
            return key;
        },
        locale: 'en',
        availableLocales: ['en']
    }
};

/**
 * No-op stand-ins for the real module's loaders — headless has no locale
 * bundles to fetch, so `t()` passing the key through above is the whole
 * translation story.
 *
 * @returns {Promise<void>}
 */
export async function loadLocalizedStrings() {}

/** @returns {Promise<void>} */
export async function updateLocalizedStrings() {}

/**
 * @param {string} _locale
 * @param {string} key
 * @returns {Promise<string>}
 */
export async function tForLocale(_locale, key) {
    return key;
}

export default i18n;
