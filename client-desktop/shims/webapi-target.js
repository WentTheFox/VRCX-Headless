/**
 * Client-side `window.WebApi` (phase 5), installed by
 * `src/plugins/interopApi.js`'s Electron branch. Same reasoning as
 * `client-web/shims/webapi-target.js` — the browser/desktop client has no
 * VRChat cookie jar of its own (§1's ownership table), so `Execute` proxies
 * the real call through the server's `/api/rpc` `webapi` target instead.
 *
 * `Execute` must never throw — `src/services/webapi.js`'s own documented
 * contract (§3.5) requires it always resolve to `{Item1, Item2}`, even on
 * failure, with `Item2` a string. Found live in phase 4's own web-client
 * pass: letting `rpcCall`'s plain `Error` (correct for `db`/`config`)
 * propagate straight through gets `JSON.stringify`'d into a useless `{}`
 * by `request.js`'s `$throw`. Built correctly here from the start instead
 * of rediscovering the same bug.
 */
import { rpcCall } from './agent-rpc.js';

export const webApiTarget = {
    async Execute(options) {
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
