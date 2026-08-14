/**
 * Client-side module alias map (phase 5) for the Electron/Linux build,
 * applied via `server/vite-alias-plugin.js`'s `headlessAliasPlugin()` — the
 * same mechanism `client-web/aliases.js` uses, reused a third time. Only
 * `database`/`config` need aliasing here, same reasoning as the web
 * client's own map: both bottom out in `src/services/sqlite.js`, which
 * needs a native `window.SQLite` binding neither split client installs
 * anymore. `updateLoop.js` gets the same treatment for the same reason
 * (the server runs the one real daemon loop).
 */
export const clientDesktopAliases = {
    'src/services/database/index.js': 'client-desktop/shims/database.js',
    'src/services/config.js': 'client-desktop/shims/config.js',
    'src/stores/updateLoop.js': 'client-desktop/shims/update-loop.js'
};
