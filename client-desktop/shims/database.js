/**
 * Client-side replacement for `src/services/database/index.js` (phase 5),
 * aliased in for the Electron/Linux build. Same reasoning and shape as
 * `client-web/shims/database.js` — the real module's ~190 methods all
 * bottom out in `src/services/sqlite.js`, which needs a native
 * `window.SQLite` binding no split client (web or desktop) installs
 * anymore — only the RPC transport differs (`./agent-rpc.js`, routed
 * through the main process rather than `fetch` directly).
 */
import { rpcCall } from './agent-rpc.js';

/**
 * Found live (2026-08-17): the server is the sole owner of `VRCX.sqlite3`
 * (§1's ownership table), but this client still runs the real, unmodified
 * `handlePipeline` (`src/services/websocket.js`) against the frames relayed
 * from the server's own `/api/stream` (`client-desktop/shims/pipeline-relay.js`)
 * — and the server's own copy of the store graph is *also* independently
 * running the exact same `handlePipeline` against its real, direct pipeline
 * connection. Any DB write that's a pure side effect of pipeline processing
 * (never reachable from a direct user action) therefore fires twice: once on
 * the server, once here, each computing its own timestamp — confirmed live
 * as genuine duplicate rows a few dozen milliseconds apart in
 * `..._feed_online_offline` (`friendPresenceCoordinator.js`'s
 * `runUpdateFriendDelayedCheckFlow`, the only two call sites of
 * `addOnlineOfflineToDatabase` in `src/**`, both inside that pipeline-only
 * flow — never called from a view/component).
 *
 * Scoped to just this one method deliberately: several other similarly-
 * shaped writes (`addFriendLogHistory`, `setFriendLogCurrent`) turned out to
 * *also* have real call sites from direct user actions
 * (`src/components/dialogs/UserDialog/useUserDialogCommands.js`), so a
 * blanket "pipeline writes are client no-ops" rule would silently break
 * those. Add a name here only after confirming (like this one) that *every*
 * call site is unreachable except through pipeline processing.
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
