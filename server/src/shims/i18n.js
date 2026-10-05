/**
 * Headless stand-in for `src/plugins/i18n.js`.
 *
 * The real module builds a vue-i18n instance and eagerly imports every locale
 * bundle. The server has no UI and only ever speaks English, so this builds a
 * single English-only instance. It must carry real messages: modules that call
 * `i18n.global.t` directly (`src/services/request.js`'s API error text, the
 * data layer's dialog labels) would otherwise surface raw keys such as
 * `api.error.message.error_message` in toasts and logs. `server/src/app.js`
 * installs this same instance on the headless app, so `useI18n()` in stores
 * and `i18n.global.t` here agree.
 */
import { readFileSync } from 'node:fs';

import { createI18n } from 'vue-i18n';

export const enMessages = JSON.parse(
    readFileSync(new URL('../../../src/localization/en.json', import.meta.url), 'utf8')
);

export const i18n = createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en: enMessages },
    missingWarn: false,
    fallbackWarn: false,
    warnHtmlMessage: false
});

/**
 * No-op stand-ins for the real module's loaders — headless has no locale
 * bundles to fetch, so the single English instance above is the whole
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
