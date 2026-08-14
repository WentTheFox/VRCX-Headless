/**
 * Client-side `window.LogWatcher` (phase 4 follow-up, found live). Unlike
 * `AppApi`/`WebApi`/`VRCXStorage`, this global was never installed at all —
 * `src/services/gameLog.js`'s unconditional boot-time
 * `LogWatcher.SetDateTill(...)` call (reached via
 * `src/coordinators/gameLogCoordinator.js`) threw a bare `ReferenceError`
 * rather than a caught Proxy error. Game-log tailing is genuinely
 * desktop-only (§1's ownership table) — no browser can read VRChat's local
 * log files — so "no log lines available" is the correct, permanent answer
 * here, not a stand-in for a missing capability.
 */
export const logWatcherTarget = {
    async Get() {
        return [];
    },
    async GetLogLines() {
        return [];
    },
    async Reset() {},
    async SetDateTill() {}
};
