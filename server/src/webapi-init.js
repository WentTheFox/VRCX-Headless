/**
 * Installs `window.WebApi`, the other half of the two-global contract
 * `src/services/webapi.js` (real, unmodified) depends on alongside
 * `window.SQLite` (`server/src/db.js`'s `installSQLiteGlobal`).
 *
 * `server/src/vrchat.js` used to do this itself, as part of building its own
 * `VRChatSession`. Phase 2b step 7 deletes that scaffold in favour of the
 * real stores driving `request.js`/`webapi.js` directly, but something still
 * has to install the global before any of that real code runs — this is
 * that something, factored out on its own since `server/src/db.js` also
 * serves the DB-only CLI commands, which need `window.SQLite` but have no
 * use for a VRChat session at all.
 */
import { CookieStore } from './cookies.js';
import { installWebApiGlobal, WebApiShim } from './shims/webapi.js';

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {{ userAgent: string }} options
 * @returns {{ webApi: WebApiShim, cookies: CookieStore }}
 */
export function installWebApi(handle, { userAgent }) {
    const cookies = new CookieStore().attach(handle.sqlite).load();
    const webApi = installWebApiGlobal(new WebApiShim({ cookies, userAgent }));
    return { webApi, cookies };
}
