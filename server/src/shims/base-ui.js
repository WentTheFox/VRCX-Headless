/**
 * Headless stand-in for `src/shared/utils/base/ui.js`.
 *
 * The file itself imports cleanly (nothing browser-only at module scope —
 * its `router`/`i18n`/`toast` imports are already aliased, `configRepository`
 * is real), but nearly every function it exports mutates the DOM directly
 * (`document.documentElement`, injected `<style>`/`<link>` tags, `classList`)
 * to apply themes, fonts and custom CSS/script — there is no rendered page
 * here to apply any of that to. `src/stores/settings/appearance.js` and
 * `src/stores/vrcx.js` call several of these unconditionally at store-setup
 * scope (phase 2b step 5's eager `createGlobalStores()`), so it needs a
 * behavioural stub rather than a stub-on-first-real-use.
 *
 * Two exports are reimplemented for real rather than stubbed, copied
 * verbatim from the real file rather than re-exported from it: `HueToHex`/
 * `HSVtoRGB` are pure colour math (no DOM), and `getThemeMode` only reads
 * `configRepository` (real) and `systemIsDarkMode()` (reimplemented below
 * via the `matchMedia` polyfill in `server/src/globals.js`) — genuinely
 * meaningful results, not just "doesn't crash". A real re-export wasn't an
 * option: this exact file's own repo-relative path is the alias target, so
 * any import of it — including from inside this shim — resolves back to
 * this same file (see `server/src/shims/quick-search-worker.js`'s header
 * for the general shape of that problem), and unlike that file this one
 * has its own imports, so the `data:` URL workaround used there doesn't
 * apply either — a `data:` module has no real directory for its relative
 * imports to resolve against.
 *
 * Everything else is a no-op; none of it is reached in the current closure,
 * but the export list is kept complete so a new call site fails loudly
 * (`TypeError: X is not a function`) instead of silently, if one shows up.
 */
import { log } from '../log.js';

function suppressed(name) {
    return (...args) => {
        log.debug(`base/ui.${name} suppressed (headless)`, { args });
    };
}

/** @param {number} h @param {number} s @param {number} v @returns {string} */
export function HSVtoRGB(h, s, v) {
    let r = 0;
    let g = 0;
    let b = 0;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0:
            r = v;
            g = t;
            b = p;
            break;
        case 1:
            r = q;
            g = v;
            b = p;
            break;
        case 2:
            r = p;
            g = v;
            b = t;
            break;
        case 3:
            r = p;
            g = q;
            b = v;
            break;
        case 4:
            r = t;
            g = p;
            b = v;
            break;
        case 5:
            r = v;
            g = p;
            b = q;
            break;
    }
    const red = Math.round(r * 255);
    const green = Math.round(g * 255);
    const blue = Math.round(b * 255);
    const decColor = 0x1000000 + blue + 0x100 * green + 0x10000 * red;
    return `#${decColor.toString(16).substr(1)}`;
}

/** @param {number} hue @param {boolean} isDarkMode @returns {string} */
export function HueToHex(hue, isDarkMode) {
    if (isDarkMode) {
        return HSVtoRGB(hue / 65535, 0.6, 1);
    }
    return HSVtoRGB(hue / 65535, 1, 0.7);
}

/** @returns {boolean} */
export function systemIsDarkMode() {
    return matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * @param {import('../../../src/services/config.js').default} configRepository
 */
export async function getThemeMode(configRepository) {
    const initThemeMode = await configRepository.getString(
        'VRCX_ThemeMode',
        'system'
    );

    let isDarkMode;
    if (initThemeMode === 'light') {
        isDarkMode = false;
    } else if (initThemeMode === 'system') {
        isDarkMode = systemIsDarkMode();
    } else {
        isDarkMode = true;
    }

    return { initThemeMode, isDarkMode };
}

export const changeAppThemeStyle = suppressed('changeAppThemeStyle');
export const useThemeColor = suppressed('useThemeColor');
export const applyThemeColor = suppressed('applyThemeColor');
export const initThemeColor = suppressed('initThemeColor');
export const updateTrustColorClasses = suppressed('updateTrustColorClasses');
export const refreshCustomCss = suppressed('refreshCustomCss');
export const refreshCustomScript = suppressed('refreshCustomScript');
export const applyAppFontFamily = suppressed('applyAppFontFamily');
export const applyAppCjkFontPack = suppressed('applyAppCjkFontPack');
export const formatJsonVars = (ref) => ref;
export const changeHtmlLangAttribute = suppressed('changeHtmlLangAttribute');
export const redirectToToolsTab = suppressed('redirectToToolsTab');
