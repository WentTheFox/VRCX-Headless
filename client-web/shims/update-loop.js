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

    return { updateLoop };
});
