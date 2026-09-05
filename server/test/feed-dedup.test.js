/**
 * See server/src/feed-dedup.js's own doc comment for the full "why": both
 * the server's own pipeline processing and every client's RPC-relayed
 * write call the exact same `database.addXToDatabase` method, and for
 * GPS/status/avatar/bio (unlike online/offline) that method is also
 * reachable from genuine direct client actions, so it can't be blocked
 * client-side the way `pipelineOnlyWrites` blocks online/offline. This
 * dedups by content at the actual write instead.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, openDatabase } from '../src/db.js';

const TEST_USER_ID = 'usr_12345678-1234-1234-1234-123456789abc';

describe('feed write deduplication', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'vrcx-headless-feed-dedup-'));
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
        await migrate(handle, { userId: TEST_USER_ID });
    });

    afterAll(() => {
        handle?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    /** Scoped to one `location`, so earlier tests' rows never bleed in. */
    function gpsRowCount(location) {
        return handle.sqlite.Execute(
            `SELECT COUNT(*) FROM ${handle.dbVars.userPrefix}_feed_gps WHERE user_id = @user_id AND location = @location`,
            { '@user_id': TEST_USER_ID, '@location': location }
        )[0][0];
    }

    it('collapses two writes with the same content a moment apart into one row', async () => {
        const entry = {
            created_at: '2026-08-18T04:00:00.000Z',
            userId: TEST_USER_ID,
            displayName: 'DupeTest',
            location: 'wrld_a:1~private(usr_test)',
            previousLocation: 'wrld_b:1~private(usr_test)',
            worldName: 'World A',
            groupName: '',
            time: 0
        };
        await handle.database.addGPSToDatabase(entry);
        await handle.database.addGPSToDatabase({
            ...entry,
            created_at: '2026-08-18T04:00:00.850Z' // 850ms later, same event relayed twice
        });

        expect(gpsRowCount('wrld_a:1~private(usr_test)')).toBe(1);
    });

    it('does not dedup genuinely different content for the same user', async () => {
        const entry = {
            created_at: '2026-08-18T05:00:00.000Z',
            userId: TEST_USER_ID,
            displayName: 'DupeTest',
            location: 'wrld_c:1~private(usr_test)',
            previousLocation: 'wrld_x:1~private(usr_test)',
            worldName: 'World C',
            groupName: '',
            time: 0
        };
        await handle.database.addGPSToDatabase(entry);
        await handle.database.addGPSToDatabase({
            ...entry,
            created_at: '2026-08-18T05:00:01.000Z',
            location: 'wrld_d:1~private(usr_test)' // a real, different second trip
        });

        expect(gpsRowCount('wrld_c:1~private(usr_test)')).toBe(1);
        expect(gpsRowCount('wrld_d:1~private(usr_test)')).toBe(1);
    });

    it('does not dedup the same content far apart in time', async () => {
        const entry = {
            created_at: '2026-08-18T06:00:00.000Z',
            userId: TEST_USER_ID,
            displayName: 'DupeTest',
            location: 'wrld_e:1~private(usr_test)',
            previousLocation: 'wrld_f:1~private(usr_test)',
            worldName: 'World E',
            groupName: '',
            time: 0
        };
        await handle.database.addGPSToDatabase(entry);
        await handle.database.addGPSToDatabase({
            ...entry,
            created_at: '2026-08-18T06:05:00.000Z' // 5 minutes later -- a real repeat trip
        });

        expect(gpsRowCount('wrld_e:1~private(usr_test)')).toBe(2);
    });
});

describe('friend log history write deduplication', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'vrcx-headless-friend-log-dedup-'));
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
        await migrate(handle, { userId: TEST_USER_ID });
    });

    afterAll(() => {
        handle?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    function friendLogRowCount(userId) {
        return handle.sqlite.Execute(
            `SELECT COUNT(*) FROM ${handle.dbVars.userPrefix}_friend_log_history WHERE user_id = @user_id`,
            { '@user_id': userId }
        )[0][0];
    }

    it('collapses the same friend-add event relayed to multiple clients into one row', async () => {
        const friendUserId = 'usr_dedup-friend-add';
        const entry = {
            created_at: '2026-09-06T04:00:00.000Z',
            type: 'Friend',
            userId: friendUserId,
            displayName: 'NewFriend',
            friendNumber: 42
        };
        await handle.database.addFriendLogHistory(entry);
        await handle.database.addFriendLogHistory({
            ...entry,
            created_at: '2026-09-06T04:00:00.600Z' // same event, relayed to a second client
        });

        expect(friendLogRowCount(friendUserId)).toBe(1);
    });

    it('does not dedup genuinely different friend log events for the same user', async () => {
        const friendUserId = 'usr_dedup-friend-distinct';
        await handle.database.addFriendLogHistory({
            created_at: '2026-09-06T05:00:00.000Z',
            type: 'Friend',
            userId: friendUserId,
            displayName: 'DistinctFriend',
            friendNumber: 43
        });
        await handle.database.addFriendLogHistory({
            created_at: '2026-09-06T05:00:00.500Z',
            type: 'DisplayName',
            userId: friendUserId,
            displayName: 'RenamedFriend',
            previousDisplayName: 'DistinctFriend',
            friendNumber: 43
        });

        expect(friendLogRowCount(friendUserId)).toBe(2);
    });

    it('does not dedup the same friend log event far apart in time', async () => {
        const friendUserId = 'usr_dedup-friend-farapart';
        const entry = {
            created_at: '2026-09-06T06:00:00.000Z',
            type: 'Unfriend',
            userId: friendUserId,
            displayName: 'ReaddedFriend'
        };
        await handle.database.addFriendLogHistory(entry);
        await handle.database.addFriendLogHistory({
            ...entry,
            created_at: '2026-09-06T06:05:00.000Z' // a genuine unfriend/refriend/unfriend cycle
        });

        expect(friendLogRowCount(friendUserId)).toBe(2);
    });
});
