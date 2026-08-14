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
    const body = await window.vrcxDesktopAgent.rpc(target, method, args);
    if (!body.ok) {
        throw new Error(body.error ?? 'RPC call failed');
    }
    return body.result;
}
