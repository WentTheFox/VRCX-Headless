/**
 * Client-side replacement for `src/services/database/index.js` (phase 4),
 * aliased in under `PLATFORM=web` (`src/vite.config.js`). The real module's
 * ~190 methods all bottom out in `src/services/sqlite.js`, which requires a
 * native `window.SQLite` binding a browser can never have — the seam
 * table's own words are "unused — client never sees SQL". A `Proxy` turns
 * every `database.anyMethod(...args)` call into a `POST /api/rpc` instead,
 * generically, without listing all ~190 names.
 *
 * Aliasing the barrel (rather than `sqlite.js` itself) also keeps every
 * `database/*.js` submodule (`feed.js`, `gameLog.js`, …) out of the client
 * bundle entirely — they're only reachable through this file, so Vite's
 * module graph never traverses into them once this alias is in place.
 *
 * `dbVars` has no server round trip: it's small, and the only two real
 * readers outside this module (`src/stores/notification/index.js:1189`,
 * `src/stores/vrcx.js:224`) just want upstream's own defaults. Caching is
 * keyed by name only (not by which default value was passed) — every real
 * call site reads a given key with a call-site-consistent default, so this
 * doesn't lose anything in practice; it just isn't literally correct for a
 * key read with two different defaults before ever being set.
 */
import { rpcCall } from './rpc-client.js';

/**
 * Found live (2026-08-17, on the desktop client, but the exact same
 * mechanism applies here): the server is the sole owner of `VRCX.sqlite3`
 * (§1's ownership table), but this client still runs the real, unmodified
 * `handlePipeline` (`src/services/websocket.js`) against the frames relayed
 * from the server's own `/api/stream` (`client-web/bootstrap.js`'s
 * `AppDebug.websocketDomain` override) — and the server's own copy of the
 * store graph is *also* independently running the exact same
 * `handlePipeline` against its real, direct pipeline connection. Any DB
 * write that's a pure side effect of pipeline processing (never reachable
 * from a direct user action) therefore fires twice: once on the server,
 * once here, each computing its own timestamp — confirmed live as genuine
 * duplicate rows a few dozen milliseconds apart in `..._feed_online_offline`
 * (`friendPresenceCoordinator.js`'s `runUpdateFriendDelayedCheckFlow`, the
 * only two call sites of `addOnlineOfflineToDatabase` in `src/**`, both
 * inside that pipeline-only flow — never called from a view/component).
 *
 * Scoped to just this one method deliberately: several other similarly-
 * shaped writes (`addFriendLogHistory`, `setFriendLogCurrent`) turned out to
 * *also* have real call sites from direct user actions
 * (`src/components/dialogs/UserDialog/useUserDialogCommands.js`), so a
 * blanket "pipeline writes are client no-ops" rule would silently break
 * those. Add a name here only after confirming (like this one) that *every*
 * call site is unreachable except through pipeline processing.
 *
 * GPS/status/avatar/bio writes have this exact same duplicate-write problem
 * (confirmed live, 2026-08-18) but can't be fixed here the same way: their
 * only call site (`src/coordinators/userEventCoordinator.js`'s
 * `runHandleUserUpdateFlow`) is reached via `applyUser` from many places,
 * not just the pipeline handler, so an always-no-op entry here would drop
 * real writes. Fixed server-side instead, by content rather than by caller
 * — see `server/src/feed-dedup.js`.
 */
const pipelineOnlyWrites = new Set(['addOnlineOfflineToDatabase']);

export const dbVars = {
    userId: '',
    userPrefix: '',
    maxTableSize: 500,
    searchTableSize: 5000
};

const localOverrides = {
    setMaxTableSize(limit) {
        dbVars.maxTableSize = limit;
        rpcCall('db', 'setMaxTableSize', [limit]).catch((err) =>
            console.error('setMaxTableSize RPC failed', err)
        );
    },
    setSearchTableSize(limit) {
        dbVars.searchTableSize = limit;
        rpcCall('db', 'setSearchTableSize', [limit]).catch((err) =>
            console.error('setSearchTableSize RPC failed', err)
        );
    }
};

export const database = new Proxy(localOverrides, {
    get(target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        if (pipelineOnlyWrites.has(prop)) return () => {};
        return (...args) => rpcCall('db', prop, args);
    }
});
