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
 */
import {
    closeSync,
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

/**
 * @param {number} pid
 * @returns {boolean} whether a process with this pid is currently alive
 */
function isProcessAlive(pid) {
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
 * @returns {{ pid: number, startedAt: string } | null} `null` if the file
 *   is missing or unparsable (treated as no real lock either way)
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
    if (existing && isProcessAlive(existing.pid)) {
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
                    startedAt: new Date().toISOString()
                })
            );
            closeSync(fd);
            return;
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            const existing = readLockFile(lockPath);
            if (existing && isProcessAlive(existing.pid)) {
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
