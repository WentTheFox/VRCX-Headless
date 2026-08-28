/**
 * The "now" used by `src/stores/activity.js` to bound a still-open self
 * activity session (the `gamelog_location` row for whatever world the user
 * most recently joined, whose `time` duration hasn't been finalized yet).
 *
 * On a live client (web or desktop), `Date.now()` is exactly correct — the
 * computation only ever runs while that client is open. The headless server
 * aliases this file (`server/aliases.js`) to a version bounded by desktop
 * agent connectivity instead, since the server itself runs independently of
 * whether anyone's actual game session is still live.
 */
export function now() {
    return Date.now();
}
