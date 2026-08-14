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
 * rejects, sometimes returns null" — so a future client-side RPC proxy
 * (phase 4) only has to handle it once.
 */

/** @type {Record<string, (handle: import('./db.js').DatabaseHandle) => any>} */
const targets = {
    db: (handle) => handle.database,
    config: (handle) => handle.configRepository
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
