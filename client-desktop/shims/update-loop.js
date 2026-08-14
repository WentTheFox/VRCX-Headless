/**
 * Client-side replacement for `src/stores/updateLoop.js` (phase 5), aliased
 * in for the Electron/Linux build. Same reasoning as
 * `client-web/shims/update-loop.js` — the server's `serve` command runs the
 * one real 1Hz daemon loop, so a second copy ticking in every connected
 * desktop client would just be redundant duplicate polling. Ships with the
 * full real store surface from the start (not just `updateLoop()`, the one
 * method `src/app.js` calls) — `src/stores/auth.js` and
 * `src/coordinators/authCoordinator.js` call `setNextCurrentUserRefresh`
 * directly, found the hard way building `client-web`'s version first
 * (invariant 4: a stub has to match the *whole* public surface).
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
