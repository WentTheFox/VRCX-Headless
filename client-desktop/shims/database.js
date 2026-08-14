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
        return (...args) => rpcCall('db', prop, args);
    }
});
