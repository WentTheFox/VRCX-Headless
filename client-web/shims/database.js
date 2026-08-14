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
