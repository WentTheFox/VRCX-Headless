/**
 * Client-side `window.WebApi` (phase 4), installed by
 * `src/plugins/interopApi.js`'s `WEB` branch. `src/services/webapi.js`
 * (real, unmodified) is the only caller of this global — same seam the
 * server fills with `server/src/shims/webapi.js`.
 *
 * `Execute` proxies the actual VRChat REST call through `/api/rpc`'s
 * `webapi` target (`server/src/rpc.js`) rather than calling `fetch` against
 * `api.vrchat.cloud` directly — the browser has no VRChat session to use
 * even if CORS allowed the request (§1's ownership table: the cookie jar is
 * server-owned). This is also what makes CORS a non-issue for phase 4 at
 * all: the browser only ever talks to its own origin.
 *
 * `GetCookies`/`SetCookies`/`ClearCookies` are no-ops. Their only real
 * caller, `src/stores/auth.js`'s `savedCredentials` persistence, exists so
 * a *desktop* app restart doesn't require re-entering VRChat credentials —
 * the server already persists its own cookie jar (`server/src/cookies.js`)
 * independent of any client, so there's nothing for a browser tab to do
 * here.
 */
import { rpcCall } from './rpc-client.js';

export const webApiTarget = {
    async Execute(options) {
        // §3.5's contract for the real WebApi.Execute (server/src/shims/webapi.js)
        // is load-bearing here too: it must never throw, always resolving to
        // {Item1, Item2} even on failure, with Item2 a *string* — src/services/webapi.js:39
        // does `throw item.Item2` on failure, and request.js's $throw does
        // `JSON.stringify(error)` for anything that isn't already a string,
        // which silently collapses an Error object to '{}'. rpcCall throws a
        // plain Error on an RPC-level failure (the right behaviour for the
        // db/config targets), so that has to be caught and re-wrapped here
        // rather than left to propagate as a rejected promise.
        try {
            return await rpcCall('webapi', 'Execute', [options]);
        } catch (err) {
            return { Item1: -1, Item2: err.message ?? String(err) };
        }
    },
    async GetCookies() {
        return '';
    },
    async SetCookies() {},
    async ClearCookies() {}
};
