/**
 * A single-writer lock for `VRCX.sqlite3`, held by whichever long-running
 * process (`serve`, `pipeline`) currently owns the VRChat pipeline
 * connection. SQLite/WAL itself gives no exclusivity signal to build this
 * on — `server/src/shims/sqlite.js` deliberately uses `locking_mode=NORMAL`
 * (ported from `Dotnet/SQLite.cs`'s own connection string) so short-lived
 * commands (`query`, `tables`, `info`) can coexist with a running `serve`;
 * `node:sqlite` has no `SQLITE_OPEN_EXCLUSIVE` equivalent either. So this is
 * a hand-rolled PID lockfile next to the database instead, using
 * `fs.openSync(path, 'wx')` — an atomic exclusive-create with no new
 * dependency (throws `EEXIST` if another lock is already there).
 *
 * This only protects against *this fork's own* processes stepping on each
 * other (two `serve`s, or `serve` + `pipeline`, against the same file) —
 * it can't stop an old, unmodified upstream desktop build from opening the
 * same `VRCX.sqlite3` directly, since that build has no idea this lockfile
 * convention exists. That gap is exactly what CLAUDE.md's own "back up
 * VRCX.sqlite3, don't run both at once" warning already covers by
 * documentation; this closes the half of the risk this fork's own code can
 * actually enforce.
 *
 * Staleness used to be checked by pid liveness alone (`kill(pid, 0)`), which
 * is unsound the moment a container is involved: if `serve` is SIGKILLed,
 * OOM-killed, or the host loses power instead of exiting cleanly (so
 * `installLockReleaseOnExit`'s handler never runs), the lockfile survives on
 * the bind-mounted data volume with the old container's pid in it — and a
 * fresh container gets its own, separately-numbered-from-zero pid namespace
 * where pid 1 (or whatever pid got reused) is *always* alive, being that
 * container's own main process. `kill(pid, 0)` has no way to tell "the
 * numerically same pid, but a completely different process" from "still the
 * same process" across that boundary, so the lock looked permanently held —
 * found via a real homelab deployment hitting exactly this after a restart.
 * Fixed by additionally recording each pid's `/proc/<pid>/stat` start-time
 * field (`readProcStartTime`) when the lock is written, and requiring it to
 * still match, when available, before trusting a `kill`-alive pid as the
 * lock's real owner — start time is stable for a process's whole lifetime
 * and, unlike a container's own uptime, measured against the shared host
 * kernel's boot clock, so it stays meaningful across a container restart.
 */
import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeSync
} from 'node:fs';

/**
 * @param {string} databasePath
 * @returns {string}
 */
function lockPathFor(databasePath) {
    return `${databasePath}.lock`;
}

/** @type {boolean | undefined} */
let procAvailable;

/**
 * @returns {boolean} whether `/proc/<pid>/stat` is readable at all on this
 *   platform — checked once via `/proc/self`, which always resolves for
 *   *this* process if procfs exists at all, regardless of which pid a
 *   later call asks about
 */
function isProcAvailable() {
    if (procAvailable === undefined) {
        procAvailable = existsSync('/proc/self/stat');
    }
    return procAvailable;
}

/**
 * A process's start-time field from `/proc/<pid>/stat` (field 22 — see
 * `man proc`), used as a PID-reuse-proof identity check: unlike the pid
 * itself, this is stable for a given process's whole lifetime and — because
 * it's measured against the *host* kernel's boot clock, not any container's
 * own uptime — stays meaningful across a container restart even though
 * containers get a fresh, reused-from-zero PID namespace each time.
 * `comm` (field 2) is parenthesized and may itself contain spaces/parens,
 * so fields are read from the *last* `)` rather than by splitting on the
 * first space.
 * @param {number} pid
 * @returns {string | null | undefined} the start-time field; `null` if
 *   `/proc` says no such process exists right now; `undefined` if that
 *   can't be determined (no procfs on this platform, or some other read
 *   error) — callers should fall back to a plain `kill(pid, 0)` probe
 */
function readProcStartTime(pid) {
    if (!isProcAvailable()) {
        return undefined;
    }
    let stat;
    try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (err) {
        return err.code === 'ENOENT' ? null : undefined;
    }
    try {
        const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
        const fields = afterComm.trim().split(' ');
        return fields[19] ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * @param {number} pid
 * @param {string | null} [procStart] the start-time this pid is *expected*
 *   to have, as recorded when the lock was written — when both this and the
 *   pid's *current* start time are available, a mismatch means the pid was
 *   reused by an unrelated process (the bug this whole check exists for:
 *   fresh containers commonly reuse pid 1 for their main process, so a lock
 *   left behind by a process that was SIGKILLed/OOM-killed/power-lost
 *   instead of exiting cleanly would otherwise look permanently "still
 *   held" on every subsequent container start). Falls back to a plain
 *   `kill(pid, 0)` probe — the only check this file had before — whenever
 *   `/proc` isn't available or the lock predates this field.
 * @returns {boolean} whether the process that (was supposed to have)
 *   written the lock is still alive
 */
function isProcessAlive(pid, procStart) {
    const currentStart = readProcStartTime(pid);
    if (currentStart === null) {
        return false;
    }
    if (currentStart !== undefined && procStart != null) {
        return currentStart === procStart;
    }
    try {
        // Signal 0 sends nothing; it only probes whether the process
        // exists and is signalable. ESRCH = gone, EPERM = alive but owned
        // by someone else (still alive from our point of view — we can't
        // safely treat it as stale).
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code !== 'ESRCH';
    }
}

/**
 * @param {string} lockPath
 * @returns {{ pid: number, startedAt: string, procStart?: string | null } | null}
 *   `null` if the file is missing or unparsable (treated as no real lock
 *   either way)
 */
function readLockFile(lockPath) {
    try {
        const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
        if (typeof contents.pid === 'number') {
            return contents;
        }
    } catch {
        // Missing, unreadable, or not JSON — treated as unlocked below.
    }
    return null;
}

/**
 * @param {string} databasePath
 * @returns {{ locked: boolean, pid?: number }}
 */
export function isLocked(databasePath) {
    const existing = readLockFile(lockPathFor(databasePath));
    if (existing && isProcessAlive(existing.pid, existing.procStart)) {
        return { locked: true, pid: existing.pid };
    }
    return { locked: false };
}

/**
 * Acquires the lock for `databasePath`, throwing a clear error if another
 * live process already holds it. A stale lock (the owning process is gone)
 * is cleaned up and the acquire retried once — a real race between two
 * processes acquiring at the same instant still correctly loses one of
 * them to `EEXIST`, since only the retry is stale-tolerant.
 *
 * @param {string} databasePath
 * @throws if another live process holds the lock
 */
export function acquireLock(databasePath) {
    const lockPath = lockPathFor(databasePath);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockPath, 'wx');
            writeSync(
                fd,
                JSON.stringify({
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                    procStart: readProcStartTime(process.pid) ?? null
                })
            );
            closeSync(fd);
            return;
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            const existing = readLockFile(lockPath);
            if (existing && isProcessAlive(existing.pid, existing.procStart)) {
                throw new Error(
                    `Another process already has ${databasePath} open (pid ${existing.pid}). ` +
                        'Only one `serve`/`pipeline` can run against a database at a time.',
                    { cause: err }
                );
            }
            // Stale lock (owning process is gone, or the file was
            // unreadable) — clean it up and let the loop retry once.
            try {
                unlinkSync(lockPath);
            } catch {
                // Another process may have already cleaned it up first;
                // either way the next attempt's openSync is authoritative.
            }
        }
    }
    throw new Error(
        `Could not acquire the lock for ${databasePath} — a concurrent process ` +
            'is racing to acquire it too.'
    );
}

/**
 * Best-effort release — safe to call even if the lock was never held (e.g.
 * a command that never called `acquireLock`).
 * @param {string} databasePath
 */
export function releaseLock(databasePath) {
    try {
        unlinkSync(lockPathFor(databasePath));
    } catch {
        // Already gone, or never existed — nothing to do.
    }
}

/**
 * Registers a `process.on('exit', ...)` fallback so the lock is released
 * even if the owning command exits without reaching its own explicit
 * cleanup path (a crash, an uncaught exception). `exit` is the one Node
 * lifecycle event guaranteed to fire synchronously no matter how the
 * process terminates, which is why the release itself has to be the sync
 * `unlinkSync` in `releaseLock` rather than anything async.
 * @param {string} databasePath
 */
export function installLockReleaseOnExit(databasePath) {
    process.on('exit', () => releaseLock(databasePath));
}
