/**
 * End-to-end check that the *unmodified* VRCX data layer
 * (`src/services/database/**` + `src/services/config.js`) runs under Node with
 * nothing but the shims swapped in. This is the load-bearing assumption of the
 * whole headless split; if it breaks after an upstream merge, stop and read the
 * change-detection checklist in CLAUDE.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, openDatabase, readTargetDatabaseVersion } from '../src/db.js';

const TEST_USER_ID = 'usr_12345678-1234-1234-1234-123456789abc';
const EXPECTED_USER_PREFIX = 'usr12345678123412341234123456789abc';

/** Global tables created by `initTables()` in src/services/database/index.js. */
const EXPECTED_GLOBAL_TABLES = [
    'avatar_memos',
    'avatar_tags',
    'cache_avatar',
    'cache_world',
    'favorite_avatar',
    'favorite_friend',
    'favorite_world',
    'gamelog_event',
    'gamelog_external',
    'gamelog_join_leave',
    'gamelog_location',
    'gamelog_portal_spawn',
    'gamelog_resource_load',
    'gamelog_video_play',
    'memos',
    'world_memos'
];

/** Per-user tables created by `initUserTables()`, minus the prefix. */
const EXPECTED_USER_TABLES = [
    'activity_bucket_cache_v2',
    'activity_sessions_v2',
    'activity_sync_state_v2',
    'avatar_history',
    'feed_avatar',
    'feed_bio',
    'feed_gps',
    'feed_online_offline',
    'feed_status',
    'friend_log_current',
    'friend_log_history',
    'moderation',
    'mutual_graph_friends',
    'mutual_graph_links',
    'mutual_graph_meta',
    'notes',
    'notifications',
    'notifications_v2'
];

describe('headless database', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'vrcx-headless-'));
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
    });

    afterAll(() => {
        handle?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    /**
     * @returns {string[]}
     */
    function tableNames() {
        return handle.sqlite
            .Execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
            .map((row) => String(row[0]));
    }

    it('migrates a fresh database to the current schema version', async () => {
        const target = readTargetDatabaseVersion();
        const result = await migrate(handle, { userId: TEST_USER_ID });

        expect(result).toEqual({
            fromVersion: 0,
            toVersion: target,
            migrated: true
        });
        expect(
            await handle.configRepository.getInt('VRCX_databaseVersion', 0)
        ).toBe(target);
    });

    it('creates every global table', () => {
        expect(tableNames()).toEqual(
            expect.arrayContaining(EXPECTED_GLOBAL_TABLES)
        );
    });

    it('creates every per-user table under the sanitised prefix', () => {
        expect(handle.dbVars.userPrefix).toBe(EXPECTED_USER_PREFIX);
        expect(tableNames()).toEqual(
            expect.arrayContaining(
                EXPECTED_USER_TABLES.map(
                    (name) => `${EXPECTED_USER_PREFIX}_${name}`
                )
            )
        );
    });

    it('creates the performance indexes added by the v16 migration', () => {
        const indexes = handle.sqlite
            .Execute(
                "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
            )
            .map((row) => String(row[0]));
        expect(indexes.length).toBeGreaterThan(0);
    });

    it('is idempotent: re-running migrate is a no-op', async () => {
        const before = tableNames().sort();
        const result = await migrate(handle, { userId: TEST_USER_ID });

        expect(result.migrated).toBe(false);
        expect(tableNames().sort()).toEqual(before);
    });

    it('round-trips through the real repository facade', async () => {
        await handle.database.setUserMemo({
            userId: TEST_USER_ID,
            editedAt: new Date(0).toJSON(),
            memo: 'met in the void'
        });

        expect(await handle.database.getUserMemo(TEST_USER_ID)).toEqual({
            userId: TEST_USER_ID,
            editedAt: new Date(0).toJSON(),
            memo: 'met in the void'
        });

        await handle.database.deleteUserMemo(TEST_USER_ID);
        expect(await handle.database.getAllUserMemos()).toEqual([]);
    });

    it('round-trips through the real configRepository', async () => {
        await handle.configRepository.setString('headlessTest', 'hello');
        expect(await handle.configRepository.getString('headlessTest')).toBe(
            'hello'
        );

        await handle.configRepository.setBool('headlessFlag', true);
        expect(await handle.configRepository.getBool('headlessFlag')).toBe(
            true
        );

        await handle.configRepository.remove('headlessTest');
        expect(
            await handle.configRepository.getString('headlessTest', 'gone')
        ).toBe('gone');
    });

    it('reads back gamelog rows written through the repository', async () => {
        await handle.database.addGamelogLocationToDatabase({
            created_at: new Date(0).toJSON(),
            type: 'Location',
            location: 'wrld_test:1~private(usr_test)',
            worldName: 'Test World',
            groupName: '',
            time: 0
        });

        const rows = handle.sqlite.Execute(
            'SELECT location, world_name FROM gamelog_location'
        );
        expect(rows).toEqual([['wrld_test:1~private(usr_test)', 'Test World']]);
    });
});
