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
    // vue-i18n instance; only `i18n.global.t` is reachable from the data layer.
    'src/plugins/i18n.js': 'server/src/shims/i18n.js',

    // NOT the whole `src/shared/utils/index.js` barrel — that barrel's other
    // ~31 sub-modules (group permissions, formatting, transforms, …) are
    // real business logic with no browser dependency, and multiple stores in
    // the phase 2b closure need them for real. Only these two pieces of it
    // can't run under Node:
    //
    // Vite-only `import.meta.glob('./*.json', …)`, called at module scope
    // regardless of which export a caller wants. `languageCodes` (the only
    // thing the closure needs) lives in the real, Vite-free `./locales.js`.
    'src/localization/index.js': 'server/src/shims/localization.js',
    // UI actions (confirm dialog, clipboard, `<a download>` click, bare
    // `AppApi.*` calls) reached via `src/shared/utils/common.js`'s
    // backward-compat re-export. Phase 2b step 4.
    'src/shared/utils/appActions.js': 'server/src/shims/app-actions.js',

    // The two edges that pull the 629-file component/view closure into any
    // background store that imports them (CLAUDE.md § "The store-graph
    // problem"). The real `plugins/index.js` re-exports `./components` (raw
    // `.vue` imports, unparseable under Node) and `./router`; the real
    // `plugins/router.js` imports every view directly to build its route
    // table. Phase 2b step 1.
    'src/plugins/index.js': 'server/src/shims/plugins-index.js',
    'src/plugins/router.js': 'server/src/shims/router.js',

    // Vite-only `?worker&inline` import; fails at resolve time under Node and
    // can't be deferred. Every message type it dispatches is a pure function
    // from `src/shared/utils/activityEngine.js`, so this runs the same
    // dispatch in-process rather than aliasing away the real `activity.js`
    // store. Phase 2b step 2.
    'src/workers/activityWorkerRunner.js':
        'server/src/shims/activity-worker-runner.js',

    // Same Vite-only `?worker&inline` problem as activityWorkerRunner.js
    // above, but this worker's search logic is stateful and deliberately
    // has zero imports (can't be split into an importable pure-function
    // module), so this alias loads the real file for real instead of
    // reimplementing it — see the shim's own header for how. Phase 2b step 4.
    'src/stores/quickSearchWorker.js':
        'server/src/shims/quick-search-worker.js',

    // Dialog bookkeeping only; calls `document.body.addEventListener` and
    // `useMagicKeys()` (@vueuse/core) at store-setup scope. A headless
    // process has no dialogs, so unlike the other phase 2b aliases this one
    // stays forever. Phase 2b step 3.
    'src/stores/ui.js': 'server/src/shims/ui.js',

    // `confirm`/`alert`/`prompt` resolve when a human clicks a dialog button
    // that only exists in a mounted Vue app; headless, they'd hang forever.
    // Stays stubbed permanently, same reasoning as `ui.js` just above.
    'src/stores/modal.js': 'server/src/shims/modal.js'

    // `src/stores/index.js` (the barrel) is intentionally NOT aliased here —
    // phase 2b step 4 imports it for real. Everything it needs that can't
    // run under Node is handled by the two aliases above plus the plugin
    // aliases, not by stubbing the barrel itself.
};

/**
 * Aliases for *bare npm specifiers*, as opposed to the repo-relative map above.
 *
 * Same rule applies — alias only what genuinely cannot run under Node — but the
 * matching is by exact package name, since there is no path to resolve.
 */
export const packageAliases = {
    // `worker-timers` schedules through a Web Worker built from a blob URL.
    // `Worker` does not exist in Node, and the failure is deferred to the first
    // setTimeout call rather than to import time, so it surfaces as a mystery
    // crash mid-run. Upstream's own vitest.setup.js mocks this the same way.
    'worker-timers': 'server/src/shims/worker-timers.js',

    // Every API error in `src/services/request.js` and the coordinators is
    // reported as a toast. Headless, those become structured log lines (and,
    // from phase 3, events on the client stream).
    'vue-sonner': 'server/src/shims/toast.js',

    // `src/stores/auth.js` and `src/coordinators/authCoordinator.js` show a
    // login/logout greeting via `new Noty(...).show()`. Unlike `vue-sonner`,
    // `noty` runs `document.addEventListener` at module load, so it can't be
    // deferred to call time — it has to be a package alias. Phase 2b step 4.
    noty: 'server/src/shims/noty.js'
};

/**
 * Extra candidate suffixes used to emulate Vite's resolver. Node's ESM loader
 * requires exact paths, but `src/**` is written for Vite and uses extensionless
 * and directory imports (e.g. `import { dbVars } from '../database'`).
 */
export const resolveExtensions = ['', '.js', '.mjs', '.json'];
export const resolveIndexFiles = ['index.js', 'index.mjs'];
