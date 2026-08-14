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
        return rpcCall('webapi', 'Execute', [options]);
    },
    async GetCookies() {
        return '';
    },
    async SetCookies() {},
    async ClearCookies() {}
};
