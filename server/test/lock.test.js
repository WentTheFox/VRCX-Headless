/**
 * `server/src/lock.js`'s PID lockfile — acquire/release round-trip, stale
 * lock cleanup, and refusal against a genuinely live process.
 */
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireLock, isLocked, releaseLock } from '../src/lock.js';

/** @type {string} */
let dir;
/** @type {string} */
let databasePath;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vrcx-headless-lock-'));
    databasePath = path.join(dir, 'VRCX.sqlite3');
    writeFileSync(databasePath, '');
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock / releaseLock', () => {
    it('acquires an uncontested lock and writes pid/startedAt', () => {
        acquireLock(databasePath);
        const lockPath = `${databasePath}.lock`;
        expect(existsSync(lockPath)).toBe(true);
        const contents = JSON.parse(readFileSync(lockPath, 'utf8'));
        expect(contents.pid).toBe(process.pid);
        expect(typeof contents.startedAt).toBe('string');
    });

    it('releasing removes the lockfile', () => {
        acquireLock(databasePath);
        releaseLock(databasePath);
        expect(existsSync(`${databasePath}.lock`)).toBe(false);
    });

    it('release is a safe no-op when nothing was ever locked', () => {
        expect(() => releaseLock(databasePath)).not.toThrow();
    });

    it('refuses to acquire while the current process already holds it', () => {
        acquireLock(databasePath);
        // process.pid (ours) is alive by definition, so this must be
        // treated as a live, contended lock, not a stale one.
        expect(() => acquireLock(databasePath)).toThrow(/already has/i);
        releaseLock(databasePath);
    });

    it('refuses to acquire when another live pid holds it', () => {
        // Our parent process (the test runner) is alive and never our own
        // pid on every platform, so isProcessAlive(process.ppid) === true
        // without needing to spawn a real child process for this test.
        // (pid 1 would only be alive on Unix.)
        writeFileSync(
            `${databasePath}.lock`,
            JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })
        );
        expect(() => acquireLock(databasePath)).toThrow(/already has/i);
    });

    it('cleans up a stale lock (dead pid) and acquires successfully', () => {
        // A pid this large is essentially guaranteed not to exist.
        const deadPid = 999999;
        writeFileSync(
            `${databasePath}.lock`,
            JSON.stringify({
                pid: deadPid,
                startedAt: new Date().toISOString()
            })
        );
        expect(() => acquireLock(databasePath)).not.toThrow();
        const contents = JSON.parse(
            readFileSync(`${databasePath}.lock`, 'utf8')
        );
        expect(contents.pid).toBe(process.pid);
    });

    it('treats an unparsable lockfile as stale and acquires over it', () => {
        writeFileSync(`${databasePath}.lock`, 'not json at all');
        expect(() => acquireLock(databasePath)).not.toThrow();
    });

    it('writes procStart alongside pid/startedAt', () => {
        acquireLock(databasePath);
        const contents = JSON.parse(
            readFileSync(`${databasePath}.lock`, 'utf8')
        );
        // null on a platform without /proc (procStart stays a graceful
        // no-op there — see isProcessAlive's kill-based fallback), a
        // non-empty string on Linux.
        expect(
            contents.procStart === null ||
                typeof contents.procStart === 'string'
        ).toBe(true);
    });

    // The start-time identity check reads /proc/<pid>/stat, so it only exists
    // where procfs does; elsewhere isProcessAlive falls back to kill(pid, 0).
    it.skipIf(!existsSync('/proc/self/stat'))('reclaims a lock whose pid was reused by an unrelated process (the container-restart bug)', () => {
        // Reproduces a real deployment failure: serve is SIGKILLed/OOM-killed
        // instead of exiting cleanly, so the lockfile survives on the
        // bind-mounted data volume with the old container's pid. A fresh
        // container gets its own pid namespace, and its own main process
        // can easily land on the exact same pid (most commonly pid 1) —
        // which a plain kill(pid, 0) can't distinguish from "still the same
        // process". Simulated here by claiming our own (definitely alive)
        // pid, but with a procStart that cannot possibly match our real one.
        writeFileSync(
            `${databasePath}.lock`,
            JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString(),
                procStart: 'not-our-actual-start-time'
            })
        );
        expect(() => acquireLock(databasePath)).not.toThrow();
        const contents = JSON.parse(
            readFileSync(`${databasePath}.lock`, 'utf8')
        );
        expect(contents.pid).toBe(process.pid);
    });

    it('still refuses when pid and procStart both genuinely match the current process', () => {
        acquireLock(databasePath);
        const held = JSON.parse(readFileSync(`${databasePath}.lock`, 'utf8'));
        releaseLock(databasePath);
        // Re-seed the exact lock our own acquire just wrote (same pid, same
        // real procStart) to simulate re-checking against a still-live
        // holder rather than relying on acquireLock's own write.
        writeFileSync(`${databasePath}.lock`, JSON.stringify(held));
        expect(() => acquireLock(databasePath)).toThrow(/already has/i);
    });
});

describe('isLocked', () => {
    it('reports unlocked when no lockfile exists', () => {
        expect(isLocked(databasePath)).toEqual({ locked: false });
    });

    it('reports locked with the pid when a live process holds it', () => {
        acquireLock(databasePath);
        expect(isLocked(databasePath)).toEqual({
            locked: true,
            pid: process.pid
        });
        releaseLock(databasePath);
    });

    it('reports unlocked for a stale lock without removing it', () => {
        const deadPid = 999999;
        writeFileSync(
            `${databasePath}.lock`,
            JSON.stringify({
                pid: deadPid,
                startedAt: new Date().toISOString()
            })
        );
        expect(isLocked(databasePath)).toEqual({ locked: false });
        // isLocked is a peek, not a cleanup -- the stale file is still there.
        expect(existsSync(`${databasePath}.lock`)).toBe(true);
    });
});
