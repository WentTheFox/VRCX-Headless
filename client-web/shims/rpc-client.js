/**
 * Shared `POST /api/rpc` helper for every phase 4 client shim
 * (`database.js`, `config.js`, `webapi-target.js`) — one place to change if
 * the wire contract (`server/src/rpc.js`) ever does. Same-origin only (the
 * project's phase 4 decision: the server serves the built client itself, so
 * there is no cross-origin case to handle here — see `client-web/bootstrap.js`).
 */

/**
 * @param {'db' | 'config' | 'webapi'} target
 * @param {string} method
 * @param {any[]} [args]
 * @returns {Promise<any>}
 */
export async function rpcCall(target, method, args = []) {
    const response = await fetch('/api/rpc', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, method, args })
    });
    if (response.status === 401) {
        throw new Error('Not authenticated with the VRCX server');
    }
    const body = await response.json();
    if (!body.ok) {
        throw new Error(body.error ?? 'RPC call failed');
    }
    return body.result;
}
