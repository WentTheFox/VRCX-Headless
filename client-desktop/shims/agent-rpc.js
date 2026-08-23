/**
 * Shared `/api/rpc` helper for every `client-desktop` shim (`database.js`,
 * `config.js`, `webapi-target.js`) — the desktop counterpart of
 * `client-web/shims/rpc-client.js`, but routed through the main process
 * (`window.vrcxDesktopAgent.rpc`, exposed by `src-electron/preload.js`)
 * instead of `fetch('/api/rpc')` directly from the renderer.
 *
 * Reason: phase 5's "always external" decision means the server is a remote
 * host:port, not same-origin — a renderer `fetch` to a remote origin hits
 * real browser CORS, which the server has deliberately never had to answer
 * (phase 4's own design note). The main process already mediates every
 * native call the exact same way (`src/ipc-electron/interopApi.js` →
 * `callDotNetMethod`), and Node's own `fetch` there isn't subject to CORS
 * at all, so routing through it sidesteps the problem entirely rather than
 * opening a new server-side CORS policy.
 *
 * `window.vrcxDesktopAgent.rpc` resolves to the server's own
 * `{ok, result}` / `{ok, error}` shape (`server/src/rpc.js`'s
 * `dispatchRpc`) — the main process's `vrcx-rpc` IPC handler
 * (`src-electron/main.js`) does the actual authenticated fetch and hands
 * that body straight back.
 */

/**
 * Reverses `server/src/http-server.js`'s `jsonReplacer` tagging of
 * `Map`/`Set` return values, recursively — the desktop counterpart of
 * `client-web/shims/rpc-client.js`'s identical function (see that file's
 * doc comment for the live bug this fixes: a `database.*` method
 * returning a real `Map`/`Set` otherwise comes back as a plain array a
 * caller only coincidentally iterates correctly, e.g.
 * `PreviousInstancesInfoDialog.vue`'s `Array.from(data.values())`).
 * `src-electron/main.js`'s `fetchJson` already parsed the server's JSON
 * into a plain object before this ever reaches the renderer, so this
 * walks the already-parsed value rather than hooking `JSON.parse` itself.
 * @param {any} value
 * @returns {any}
 */
function reviveRpcValue(value) {
    if (Array.isArray(value)) {
        return value.map(reviveRpcValue);
    }
    if (value && typeof value === 'object') {
        if (value.__rpcType === 'Map' && Array.isArray(value.entries)) {
            return new Map(value.entries.map(([k, v]) => [k, reviveRpcValue(v)]));
        }
        if (value.__rpcType === 'Set' && Array.isArray(value.values)) {
            return new Set(value.values.map(reviveRpcValue));
        }
        const result = {};
        for (const key of Object.keys(value)) {
            result[key] = reviveRpcValue(value[key]);
        }
        return result;
    }
    return value;
}

/**
 * @param {'db' | 'config' | 'webapi'} target
 * @param {string} method
 * @param {any[]} [args]
 * @returns {Promise<any>}
 */
export async function rpcCall(target, method, args = []) {
    // Real src/** call sites routinely pass a live Vue reactive object as an
    // argument (e.g. the current user, a location object) — fine for
    // client-web/shims/rpc-client.js's fetch()+JSON.stringify(args), which
    // walks a Proxy transparently, but window.vrcxDesktopAgent.rpc crosses
    // Electron's contextBridge via the structured clone algorithm, which
    // throws "An object could not be cloned" on a reactive Proxy. Found live
    // (2026-08-17): a real Discord presence update, once VRChat was actually
    // running, surfaced this on the very next RPC call. JSON-round-tripping
    // here strips reactivity down to plain data before the IPC hop, matching
    // exactly what the web client's network transport already does.
    const plainArgs = JSON.parse(JSON.stringify(args));
    const body = await window.vrcxDesktopAgent.rpc(target, method, plainArgs);
    if (!body.ok) {
        throw new Error(body.error ?? 'RPC call failed');
    }
    return reviveRpcValue(body.result);
}
