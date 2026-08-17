// @ts-nocheck
import { toast } from 'vue-sonner';

import InteropApi from '../ipc-electron/interopApi.js';
import configRepository from '../services/config.js';
import vrcxJsonStorage from '../services/jsonStorage.js';

/**
 * Phase 6 part 2: `database`/`configRepository`'s ~86 fire-and-forget write
 * call sites across `src/**` were audited (see CLAUDE.md §9) and found to
 * contain no correctness bugs — upstream never consumed their return value
 * either, by design. What *was* missing is that a failed write is
 * completely silent client-side: on the server these calls run in-process
 * and a thrown error surfaces normally, but on `WEB`/the Electron client
 * they're RPC calls returning a rejected promise nothing awaits, which
 * Node/the browser would otherwise just drop. This is the one generic
 * catch-all for that gap, reusing the same `vue-sonner` toast convention
 * `src/services/request.js` and 13 coordinators already use for API
 * failures, rather than inventing new UX.
 *
 * Not installed on the `WINDOWS`/CefSharp branch: `window.SQLite` is real
 * and local there, so upstream's original fire-and-forget assumption still
 * holds — there is no RPC hop to swallow a rejection, and adding this
 * listener would just be toast noise for a gap that branch doesn't have.
 */
function installUnhandledRejectionReporting() {
    window.addEventListener('unhandledrejection', (event) => {
        console.error('Unhandled rejection', event.reason);
        // client-web/shims/app-api.js's Proxy already toasts unimplemented-
        // capability errors itself, at throw time, specifically so a call
        // site that catches and swallows the rejection still surfaces one —
        // this listener exists for the complementary case, a rejection
        // *nothing* handles. Without the alreadyToasted check both fire for
        // the same failure, since a rejection nothing catches is both
        // "thrown by the Proxy" and "unhandled".
        if (event.reason?.alreadyToasted) {
            return;
        }
        const message =
            event.reason instanceof Error
                ? event.reason.message
                : String(event.reason);
        toast.error(`Something went wrong: ${message}`);
    });
}

export async function initInteropApi(isVrOverlay = false) {
    if (isVrOverlay) {
        if (WINDOWS) {
            await CefSharp.BindObjectAsync('AppApiVr');
        } else {
            // @ts-ignore
            window.AppApiVr = InteropApi.AppApiVrElectron;
        }
    } else {
        // #region | Init Cef C# bindings
        if (WINDOWS) {
            await CefSharp.BindObjectAsync(
                'AppApi',
                'WebApi',
                'VRCXStorage',
                'SQLite',
                'LogWatcher',
                'Discord',
                'AssetBundleManager'
            );
        } else if (WEB) {
            // Phase 4: no native/Electron bindings exist at all — every
            // global here is a client-web shim proxying to the server's
            // /api/rpc dispatcher instead. window.SQLite is deliberately
            // not installed: nothing reaches it once services/database and
            // services/config are aliased away (see the Vite alias map
            // under PLATFORM=web). LogWatcher is stubbed (found live: an
            // unconditional boot-time call threw a bare ReferenceError
            // otherwise). Discord/AssetBundleManager are desktop-only
            // capabilities with no web equivalent and, unlike LogWatcher,
            // aren't reached from any unconditional call site — left
            // unset on purpose rather than stubbed speculatively.
            // Dynamic import (not a static one) so WINDOWS/Electron builds,
            // where WEB is a compile-time `false`, tree-shake this whole
            // subtree away instead of bundling client-web/** dead weight.
            const { webApiTarget } =
                await import('../../client-web/shims/webapi-target.js');
            const { appApiTarget } =
                await import('../../client-web/shims/app-api.js');
            const { vrcxStorageTarget } =
                await import('../../client-web/shims/vrcx-storage.js');
            const { logWatcherTarget } =
                await import('../../client-web/shims/log-watcher.js');
            window.WebApi = webApiTarget;
            window.AppApi = appApiTarget;
            window.VRCXStorage = vrcxStorageTarget;
            window.LogWatcher = logWatcherTarget;
            installUnhandledRejectionReporting();
        } else {
            // Phase 5: the desktop build stops opening VRCX.sqlite3 and
            // talking to api.vrchat.cloud directly (§1's ownership table —
            // "the .NET side stops opening it entirely"), both now
            // server-owned exactly like the web client. window.SQLite is no
            // longer installed at all — nothing reaches it once
            // services/database and services/config are aliased away (see
            // client-desktop/aliases.js), same fact phase 4 already proved
            // for the web client. window.WebApi becomes the RPC-backed
            // target (client-desktop/shims/webapi-target.js), proxying the
            // real VRChat call through the server's /api/rpc `webapi`
            // target instead of InteropApi.WebApi's real .NET object.
            //
            // Everything else here is untouched: AppApi/LogWatcher/Discord/
            // AssetBundleManager/AppApiVrElectron stay the real
            // InteropApi.* objects — VR overlay, Discord RPC, log tailing,
            // registry and screenshots are genuinely machine-local
            // capabilities that never touched the database or VRChat's API
            // in the first place, so the renderer's own direct native calls
            // keep working exactly as they do today. The *server* reaching
            // back into this same capability over the new agent channel
            // (server/src/agent.js) is additional, not a replacement for
            // this.
            //
            // Dynamic import (not a static one), same reasoning as the WEB
            // branch above: a WINDOWS/CefSharp build tree-shakes this whole
            // subtree away instead of bundling client-desktop/** dead
            // weight.
            const { webApiTarget } =
                await import('../../client-desktop/shims/webapi-target.js');
            const { installPipelineRelay } =
                await import('../../client-desktop/shims/pipeline-relay.js');
            installPipelineRelay();
            window.AppApi = InteropApi.AppApiElectron;
            window.WebApi = webApiTarget;
            window.VRCXStorage = InteropApi.VRCXStorage;
            window.LogWatcher = InteropApi.LogWatcher;
            window.Discord = InteropApi.Discord;
            window.AssetBundleManager = InteropApi.AssetBundleManager;
            window.AppApiVrElectron = InteropApi.AppApiVrElectron;
            installUnhandledRejectionReporting();
        }

        await configRepository.init();
        if (!WEB) {
            // The web client's VRCXStorage shim already implements
            // GetArray/SetArray/GetObject/SetObject natively — this
            // wrapper exists only to bolt those onto the native
            // Electron/CEF binding, which lacks them.
            new vrcxJsonStorage(VRCXStorage);
        }

        AppApi.SetUserAgent();
    }
}
