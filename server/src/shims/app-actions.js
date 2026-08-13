/**
 * Headless stand-in for `src/shared/utils/appActions.js`.
 *
 * Reached through `src/shared/utils/common.js`'s backward-compat re-export,
 * which is itself part of the real `src/shared/utils/index.js` barrel (that
 * barrel runs unmodified — see CLAUDE.md § "Seam table" — this is the one
 * file inside it that can't). Every export here is a UI action: a file-save
 * `<a download>` click, `navigator.clipboard`, an interactive confirm dialog
 * gating `AppApi.OpenLink`, or a bare `AppApi.*` call. `AppApi` itself isn't
 * even a defined global on the server yet (that's phase 2b step 9), so the
 * two direct-call exports would throw a `ReferenceError` the moment
 * something invoked them for real, not just at import time.
 *
 * `src/services/sqlite.js` is the original, still the only reachable caller,
 * for `openExternalLink` — logging and no-oping preserves its behaviour
 * (surface the SQLite error, don't try to act on a link no one can click).
 */
import { log } from '../log.js';

/**
 * @param {string} fileName
 */
export function downloadAndSaveJson(fileName) {
    log.info('downloadAndSaveJson suppressed (headless)', { fileName });
}

/**
 * @param {string} text
 */
export function copyToClipboard(text) {
    log.info('copyToClipboard suppressed (headless)', { text });
}

/**
 * @param {string} link
 */
export function openExternalLink(link) {
    log.info('openExternalLink suppressed (headless)', { link });
}

/**
 * @param {string} discordId
 */
export function openDiscordProfile(discordId) {
    log.info('openDiscordProfile suppressed (headless)', { discordId });
}

/**
 * @param {string} path
 */
export function openFolderGeneric(path) {
    log.info('openFolderGeneric suppressed (headless)', { path });
}
