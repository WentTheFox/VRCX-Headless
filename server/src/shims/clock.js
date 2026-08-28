/**
 * Server-side override of `src/shared/utils/clock.js`, aliased in
 * `server/aliases.js`.
 *
 * `src/stores/activity.js` uses this as the "now" that bounds a still-open
 * self activity session — the `gamelog_location` row for whatever world the
 * user most recently joined, whose `time` duration only ever gets finalized
 * by a *live desktop client* noticing the game stopped or a new world was
 * joined (`src/coordinators/locationCoordinator.js`'s
 * `runLastLocationResetFlow`, driven by `client-desktop/shims/update-loop.js`
 * polling `AppApi.IsGameRunning()` in the Electron renderer — the headless
 * server can't run that poll itself, since its own `LINUX` compile flag is
 * `false`, same reasoning as that shim's own doc comment).
 *
 * Found live: with the server running continuously and no desktop client
 * open, that last `gamelog_location` row sits at `time = 0` forever, and
 * `buildSessionsFromGamelog` (`src/shared/utils/activityEngine.js`) treats a
 * `time = 0` *last* row as "still ongoing", filling the gap with
 * `min(nowMs - start, 24h)`. Plugging in the server's own `Date.now()` there
 * — correct for a live client, where the computation only ever runs while
 * that client is open — manufactures up to a fixed 24h "still online" block
 * anchored at the last real join, every time the cache rebuilds, regardless
 * of whether anyone was actually playing. That block then overlaps whatever
 * a friend happened to be online during, skewing the Activity tab's overlap
 * percentage toward 100%.
 *
 * `desktopAgent.getPresenceHorizon()` bounds that fill to "the last instant
 * this process actually knows a desktop client was connected" instead —
 * live while connected, frozen at the last disconnect otherwise — so the
 * open tail stops growing the moment nobody's actually there to observe it,
 * matching what a live client's own `Date.now()` would already give you.
 */
import { desktopAgent } from '../agent.js';

export function now() {
    return desktopAgent.getPresenceHorizon();
}
