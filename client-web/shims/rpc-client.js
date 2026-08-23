/**
 * Shared `POST /api/rpc` helper for every phase 4 client shim
 * (`database.js`, `config.js`, `webapi-target.js`) — one place to change if
 * the wire contract (`server/src/rpc.js`) ever does. Same-origin only (the
 * project's phase 4 decision: the server serves the built client itself, so
 * there is no cross-origin case to handle here — see `client-web/bootstrap.js`).
 */

/**
 * Reverses `server/src/http-server.js`'s `jsonReplacer` tagging of
 * `Map`/`Set` return values, recursively, so a `database.*` method that
 * returns a real `Map`/`Set` (`getPlayersFromInstance`,
 * `getInstanceJoinHistory`, several others — see that file's own doc
 * comment for the live bug this fixes) comes back as a real `Map`/`Set`
 * client-side too, not an array a caller only coincidentally iterates
 * correctly. Every `src/**` call site was written against real
 * `Map`/`Set` semantics (`.values()`, `.get()`, `.has()`, `.size`) since
 * that's what it gets in the unmodified upstream desktop build.
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
    return reviveRpcValue(body.result);
}
