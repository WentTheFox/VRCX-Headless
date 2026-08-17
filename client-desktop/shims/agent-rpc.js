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
    return body.result;
}
