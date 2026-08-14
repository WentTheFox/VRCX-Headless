/**
 * Client-side replacement for `src/stores/updateLoop.js` (phase 4), aliased
 * in under `PLATFORM=web`. The seam table already prescribes this: "no-op
 * store" — the server's `serve` command runs the one real 1Hz daemon loop
 * (`server/src/cli.js`), so a second copy ticking in every connected
 * browser tab would just be redundant duplicate polling. `src/app.js` calls
 * `store.updateLoop.updateLoop()` once at boot (unmodified — this stub is
 * what it lands on), same reasoning and shape as `server/src/shims/ui.js`.
 */
import { defineStore } from 'pinia';

export const useUpdateLoopStore = defineStore('UpdateLoop', () => {
    function updateLoop() {}
    function setIpcTimeout() {}
    function setNextCurrentUserRefresh() {}
    function setNextDiscordUpdate() {}
    function setNextGroupInstanceRefresh() {}
    function setNextClearVRCXCacheCheck() {}

    return {
        // Found live: src/stores/auth.js and src/coordinators/authCoordinator.js
        // call updateLoopStore.setNextCurrentUserRefresh(...) directly
        // (invariant 4 — this store's public surface has to match the real
        // one byte-for-byte, not just the one method src/app.js happens to
        // call). The counters themselves drive timing inside the real
        // updateLoop()'s own tick, which is a no-op here, so a static 0 is
        // as meaningful as any other value.
        nextGroupInstanceRefresh: 0,
        nextCurrentUserRefresh: 0,
        nextDiscordUpdate: 0,
        ipcTimeout: 0,
        updateLoop,
        setIpcTimeout,
        setNextCurrentUserRefresh,
        setNextDiscordUpdate,
        setNextGroupInstanceRefresh,
        setNextClearVRCXCacheCheck
    };
});
