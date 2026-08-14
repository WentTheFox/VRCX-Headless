/**
 * The generic `/api/rpc` dispatcher (phase 3). `database.*`
 * (`src/services/database/index.js`) and `configRepository.*`
 * (`src/services/config.js`) are both flat method-bag objects — ~190 and 12
 * methods respectively, per CLAUDE.md's seam table — which is exactly what
 * makes one generic dispatcher possible instead of per-method wiring.
 *
 * No per-method allowlist beyond "is this actually a callable method": that
 * full surface is what the desktop app itself uses locally with no
 * additional restriction, and the authenticated session
 * (`server/src/http-auth.js`) is the security boundary here, not method
 * filtering. `target`/`method` are still validated defensively — a bad
 * request should reach a `{ ok: false }` response, not a crash, and
 * `constructor`/other non-function properties are rejected the same way an
 * unknown method name is.
 *
 * Return shape mirrors `server/src/shims/webapi.js`'s `{ Item1, Item2 }`
 * tuple in spirit — one error contract, not "sometimes throws, sometimes
 * rejects, sometimes returns null" — so a client-side RPC proxy only has to
 * handle it once.
 *
 * Phase 4 adds a third target, `webapi`, mapping to the already-installed
 * `globalThis.WebApi` (`server/src/webapi-init.js`) rather than anything on
 * `handle` — it's a single global instance, not per-database state. This is
 * how the web client's `Execute`/`GetCookies`/etc. calls (proxied from
 * `src/services/webapi.js`, unmodified, via a `window.WebApi` shim installed
 * client-side) actually reach VRChat: the browser never talks to
 * `api.vrchat.cloud` directly, only to this dispatcher, which runs with the
 * server's real cookie jar.
 */

/** @type {Record<string, (handle: import('./db.js').DatabaseHandle) => any>} */
const targets = {
    db: (handle) => handle.database,
    config: (handle) => handle.configRepository,
    webapi: () => globalThis.WebApi
};

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {{ target?: unknown, method?: unknown, args?: unknown }} request
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export async function dispatchRpc(handle, request) {
    const { target, method, args } = request ?? {};

    if (typeof target !== 'string' || !(target in targets)) {
        return {
            ok: false,
            error: `Unknown RPC target: ${JSON.stringify(target)}`
        };
    }
    if (typeof method !== 'string') {
        return { ok: false, error: 'RPC method must be a string' };
    }
    const targetObject = targets[target](handle);
    if (!targetObject) {
        // Only reachable for 'webapi' if a caller wires up dispatchRpc
        // without installWebApi() having run first — 'db'/'config' always
        // exist on a successfully opened handle.
        return { ok: false, error: `RPC target not available: ${target}` };
    }
    const fn = targetObject[method];
    // `method in Object.prototype` catches `constructor`, `__proto__`,
    // `hasOwnProperty`, `toString`, etc. in one check — every real method on
    // `database`/`configRepository` is a call site's own name, never one of
    // these, so there is nothing legitimate this rejects. `typeof fn ===
    // 'function'` alone isn't enough: `typeof Object === 'function'` is
    // true, so a bare typeof check lets `constructor` straight through.
    if (method in Object.prototype || typeof fn !== 'function') {
        return {
            ok: false,
            error: `Unknown RPC method: ${target}.${method}`
        };
    }
    const callArgs = Array.isArray(args) ? args : [];

    try {
        const result = await fn.apply(targetObject, callArgs);
        return { ok: true, result: result === undefined ? null : result };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
