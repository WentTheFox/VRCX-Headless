/**
 * Client-side replacement for `src/stores/updateLoop.js` (phase 5), aliased
 * in for the Electron/Linux build. Same reasoning as
 * `client-web/shims/update-loop.js` for the VRChat-API-polling half — the
 * server's `serve` command runs the one real 1Hz daemon loop for that, so a
 * second copy ticking in every connected desktop client would just be
 * redundant duplicate polling. Ships with the full real store surface from
 * the start (not just `updateLoop()`, the one method `src/app.js` calls) —
 * `src/stores/auth.js` and `src/coordinators/authCoordinator.js` call
 * `setNextCurrentUserRefresh` directly, found the hard way building
 * `client-web`'s version first (invariant 4: a stub has to match the
 * *whole* public surface).
 *
 * Found live (2026-08-17): the real `updateLoop.js` also has an
 * `if (LINUX && ...)` block polling `AppApi.IsGameRunning()`/
 * `IsSteamVRRunning()`, `LogWatcher.GetLogLines()`, and `vrStore.vrInit()`
 * once a second — upstream's mechanism for the Linux Electron client to
 * check *local-machine* state itself, as opposed to the VRChat-API state
 * above. Aliasing the whole store to a no-op silently dropped that block
 * everywhere: it can't run server-side either, since the server's own
 * `LINUX` compile flag is `false` (`server/src/globals.js` — the server is
 * neither the CEF/Windows nor the Electron/Linux build). Net effect: the
 * "game" status indicator, SteamVR detection, VR init, and GameLog tailing
 * were all silently dead on the desktop client. Unlike the VRChat-API half,
 * these four are genuinely local-machine capabilities this client already
 * has direct native access to (`window.AppApi`/`window.LogWatcher` are the
 * real `InteropApi.*` objects here, per the seam table) — so this file runs
 * them itself instead of relying on any server relay, on any OS (not
 * `LINUX`-gated — the real flag only ever meant "not CefSharp", which
 * already pushes this same state its own way via `ExecuteScriptAsync`, and
 * this shim is never even loaded under `WINDOWS`/CefSharp in the first
 * place).
 */
import { defineStore } from 'pinia';

import { runUpdateIsGameRunningFlow } from '../../src/coordinators/gameCoordinator.js';
import { addGameLogEvent } from '../../src/coordinators/gameLogCoordinator.js';
import { useVrStore } from '../../src/stores/vr.js';
import { watchState } from '../../src/services/watchState.js';

import * as workerTimers from 'worker-timers';

export const useUpdateLoopStore = defineStore('UpdateLoop', () => {
    const vrStore = useVrStore();
    let started = false;

    /**
     *
     */
    async function localMachineLoop() {
        try {
            if (watchState.isLoggedIn) {
                const logLines = await LogWatcher.GetLogLines();
                if (logLines) {
                    logLines.forEach((logLine) => {
                        addGameLogEvent(logLine);
                    });
                }
                await runUpdateIsGameRunningFlow(
                    await AppApi.IsGameRunning(),
                    await AppApi.IsSteamVRRunning()
                );
                vrStore.vrInit(); // TODO: make this event based
            }
        } catch (err) {
            console.error(err);
        }
        workerTimers.setTimeout(() => localMachineLoop(), 1000);
    }

    /**
     *
     */
    function updateLoop() {
        if (started) {
            return;
        }
        started = true;
        localMachineLoop();
    }

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
