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

export default i18n;
