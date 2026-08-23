/**
 * `window.updateService` (fork addition), installed by
 * `src/plugins/interopApi.js`'s Electron branch — backs the server-driven
 * desktop updater (`src/stores/vrcxUpdater.js`'s `checkForForkUpdate`).
 * Proxies to the server's `update` RPC target (`server/src/rpc.js` →
 * `server/src/update-release.js`), which is the only side that knows this
 * server's own fork version and can check GitHub for the matching release.
 *
 * Unlike `webapi-target.js`, this has no upstream contract to match — it's
 * a new, fork-only capability, so its shape is whatever's convenient rather
 * than mirroring a `Dotnet/AppApi/**` method.
 */
import { rpcCall } from './agent-rpc.js';

export const updateService = {
    /**
     * @param {{ force?: boolean }} [options]
     * @returns {Promise<{ serverVersion: string, release: object | null }>}
     */
    async getUpdateInfo(options = {}) {
        return rpcCall('update', 'getUpdateInfo', [options]);
    }
};
