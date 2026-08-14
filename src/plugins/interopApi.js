// @ts-nocheck
import InteropApi from '../ipc-electron/interopApi.js';
import configRepository from '../services/config.js';
import vrcxJsonStorage from '../services/jsonStorage.js';

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
        } else {
            window.AppApi = InteropApi.AppApiElectron;
            window.WebApi = InteropApi.WebApi;
            window.VRCXStorage = InteropApi.VRCXStorage;
            window.SQLite = InteropApi.SQLite;
            window.LogWatcher = InteropApi.LogWatcher;
            window.Discord = InteropApi.Discord;
            window.AssetBundleManager = InteropApi.AssetBundleManager;
            window.AppApiVrElectron = InteropApi.AppApiVrElectron;
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
