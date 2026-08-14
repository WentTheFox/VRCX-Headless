/**
 * Client-side module alias map (phase 4), applied under `PLATFORM=web` via
 * `server/vite-alias-plugin.js`'s `headlessAliasPlugin()` — reused as-is
 * rather than reimplemented: it already does resolved-absolute-path
 * matching (robust against however an importer spells a relative path),
 * parameterized by exactly this kind of map. See `server/aliases.js` for
 * the server-side counterpart and CLAUDE.md's "Invariants"/"Seam table".
 *
 * Much smaller than the server's alias map: everything the server had to
 * alias away (`src/plugins/index.js`/`router.js`, `src/stores/ui.js`/
 * `modal.js`, `import.meta.glob`, `?worker&inline`, …) is either Vite-only
 * syntax — which a real `vite build` handles natively, unlike the server's
 * raw-Node loader — or a real browser capability (dialogs, Web Workers)
 * the headless server never had. A real browser running the real Vue app
 * needs almost none of that. Only the three seams a browser genuinely
 * cannot cross unmodified:
 */
export const clientWebAliases = {
    // ~190-method facade over src/services/sqlite.js, which needs a native
    // window.SQLite binding no browser has. Aliasing the barrel (not
    // sqlite.js itself) keeps every database/*.js submodule out of the
    // client bundle too — they're only reachable through this file.
    'src/services/database/index.js': 'client-web/shims/database.js',

    // Same story, one layer down: config.js also bottoms out in sqlite.js.
    'src/services/config.js': 'client-web/shims/config.js',

    // The seam table already prescribes this: "no-op store" — the server's
    // `serve` command runs the one real 1Hz daemon loop; a second one
    // ticking in every browser tab would just be redundant duplicate
    // polling.
    'src/stores/updateLoop.js': 'client-web/shims/update-loop.js'
};
