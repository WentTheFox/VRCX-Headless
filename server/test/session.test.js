/**
 * `scheduleSessionRestoreRetries` (`server/src/session.js`) — the retry loop
 * that self-heals a `serve` process from "restoreSession() didn't resolve
 * with a user at boot" without needing a manual restart. Uses the
 * `restoreSessionFn`/`waitForPipelineConnectedFn` test seams (same "default
 * parameter as injection point" pattern as
 * `src/coordinators/authAutoLoginCoordinator.js`'s own `isOnline` option)
 * since real ESM bindings can't be mocked the way `module.exports` can.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { openDatabase } from '../src/db.js';
import { scheduleSessionRestoreRetries } from '../src/session.js';

describe('scheduleSessionRestoreRetries', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'vrcx-headless-session-retry-'));
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
        await handle.configRepository.init();
    });

    afterAll(() => {
        handle?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await handle.configRepository.setString('lastUserLoggedIn', '');
        vi.useRealTimers();
    });

    /** @returns {{ updateLoop: ReturnType<typeof vi.fn> }} */
    function fakeStores() {
        return { updateLoop: { updateLoop: vi.fn() } };
    }

    it('is a no-op when there was never a saved session to restore', async () => {
        // lastUserLoggedIn deliberately left unset for this one test.
        const restoreSessionFn = vi.fn();
        const stores = fakeStores();

        const stop = await scheduleSessionRestoreRetries(stores, handle, {
            restoreSessionFn
        });

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(restoreSessionFn).not.toHaveBeenCalled();
        expect(stores.updateLoop.updateLoop).not.toHaveBeenCalled();
        stop();
    });

    it('retries on the documented backoff and stops once restoreSession succeeds', async () => {
        await handle.configRepository.setString('lastUserLoggedIn', 'usr_test');
        const restoreSessionFn = vi
            .fn()
            .mockResolvedValueOnce(null) // attempt 1: still not connected
            .mockResolvedValueOnce(null) // attempt 2: still not connected
            .mockResolvedValueOnce({ id: 'usr_test' }); // attempt 3: connected
        const waitForPipelineConnectedFn = vi.fn().mockResolvedValue(undefined);
        const stores = fakeStores();

        const stop = await scheduleSessionRestoreRetries(stores, handle, {
            restoreSessionFn,
            waitForPipelineConnectedFn,
            retryDelaysMs: [10_000, 30_000, 60_000],
            steadyStateMs: 300_000
        });

        expect(restoreSessionFn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(3);
        expect(waitForPipelineConnectedFn).toHaveBeenCalledTimes(1);
        expect(stores.updateLoop.updateLoop).toHaveBeenCalledTimes(1);

        // No further retries scheduled after success.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(3);
        expect(stores.updateLoop.updateLoop).toHaveBeenCalledTimes(1);

        stop();
    });

    it('falls back to the steady-state delay once the fixed backoff schedule is exhausted', async () => {
        await handle.configRepository.setString('lastUserLoggedIn', 'usr_test');
        const restoreSessionFn = vi.fn().mockResolvedValue(null);
        const stores = fakeStores();

        const stop = await scheduleSessionRestoreRetries(stores, handle, {
            restoreSessionFn,
            retryDelaysMs: [1_000],
            steadyStateMs: 5_000
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(1);

        // Fixed schedule exhausted — next retry should be steadyStateMs, not
        // immediate.
        await vi.advanceTimersByTimeAsync(4_999);
        expect(restoreSessionFn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(restoreSessionFn).toHaveBeenCalledTimes(2);

        stop();
    });

    it('the returned stop function prevents any further retries', async () => {
        await handle.configRepository.setString('lastUserLoggedIn', 'usr_test');
        const restoreSessionFn = vi.fn().mockResolvedValue(null);
        const stores = fakeStores();

        const stop = await scheduleSessionRestoreRetries(stores, handle, {
            restoreSessionFn,
            retryDelaysMs: [1_000],
            steadyStateMs: 1_000
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(1);

        stop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(restoreSessionFn).toHaveBeenCalledTimes(1);
    });
});
