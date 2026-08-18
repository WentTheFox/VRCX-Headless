/**
 * Client-side `window.AssetBundleManager` (web only, found live). This global
 * was never installed at all — `checkVRChatCache()`
 * (`src/coordinators/cacheCoordinator.js`) calls `AssetBundleManager.
 * CheckVRChatCache(...)` unconditionally every time a world/avatar dialog
 * opens or the instance panel updates a world/avatar, not from a
 * user-triggered button, so it threw a bare `ReferenceError` on every one of
 * those instead of a caught Proxy error. Real usage
 * (`Dotnet/AssetBundleManager.cs`) inspects a local VRChat install's asset
 * cache on disk — a browser tab has no such cache, so "nothing cached" is the
 * correct, permanent answer to `CheckVRChatCache`, not a stand-in.
 * `DeleteCache` *is* only reached from a user-triggered button (the trash
 * icon on those same dialogs), so it keeps the throw-by-default convention
 * `client-web/shims/app-api.js` uses — there's nothing to delete.
 */
export const assetBundleManagerTarget = {
    async CheckVRChatCache() {
        return { Item1: -1, Item2: false, Item3: '' };
    },
    async DeleteCache() {
        throw new Error('AssetBundleManager.DeleteCache is not available in the web client');
    }
};
