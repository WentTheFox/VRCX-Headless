/**
 * Server-side module alias map.
 *
 * This is the mechanism that lets the headless server import VRCX's real data
 * layer (`src/services/database/**`, `src/services/config.js`) *without editing
 * a single line of it*. See CLAUDE.md -> "Invariants" and "Seam table".
 *
 * Keys and values are repo-relative POSIX paths. A key is matched against the
 * fully-resolved path of an import target, so it does not matter whether the
 * importing module wrote `../stores`, `../../stores/index.js`, etc.
 *
 * Rule of thumb: alias the smallest module that pulls in a browser-only
 * dependency. Do NOT alias a module just because it is large.
 */
export const aliases = {
    // `src/services/sqlite.js` renders SQLite failures as modal dialogs.
    // Headless has no modals; the stub logs and re-throws so callers behave the same.
    'src/stores/index.js': 'server/src/shims/stores.js',

    // vue-i18n instance; only `i18n.global.t` is reachable from the data layer.
    'src/plugins/i18n.js': 'server/src/shims/i18n.js',

    // `openExternalLink` is the only symbol the data layer pulls from here, and
    // the real module reaches for `window.open` / AppApi.
    'src/shared/utils/index.js': 'server/src/shims/shared-utils.js'
};

/**
 * Extra candidate suffixes used to emulate Vite's resolver. Node's ESM loader
 * requires exact paths, but `src/**` is written for Vite and uses extensionless
 * and directory imports (e.g. `import { dbVars } from '../database'`).
 */
export const resolveExtensions = ['', '.js', '.mjs', '.json'];
export const resolveIndexFiles = ['index.js', 'index.mjs'];
