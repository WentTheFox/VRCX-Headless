/**
 * Opens VRCX.sqlite3 and runs the *existing* JavaScript migration layer against
 * it — `src/services/database/**` and `src/services/config.js` are imported
 * unmodified. This module is the proof of the whole design: if the data layer
 * runs here, the server can own the database without forking it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { installFeedDedup } from './feed-dedup.js';
import { repoRoot } from './globals.js';
import { log } from './log.js';
import { resolveDatabasePath } from './paths.js';
import { installSQLiteGlobal, SQLiteShim } from './shims/sqlite.js';

/**
 * Target schema version, as hardcoded in `updateDatabaseVersion()` in
 * src/stores/vrcx.js. Read out of the source rather than duplicated, so an
 * upstream bump is picked up instead of silently skipping migrations.
 *
 * @returns {number}
 */
export function readTargetDatabaseVersion() {
    const fallback = 16;
    try {
        const source = readFileSync(
            path.join(repoRoot, 'src', 'stores', 'vrcx.js'),
            'utf8'
        );
        const match = source.match(/const\s+databaseVersion\s*=\s*(\d+)\s*;/);
        if (match) {
            return Number(match[1]);
        }
        log.warn(
            'Could not find `const databaseVersion = N` in src/stores/vrcx.js; ' +
                `falling back to ${fallback}. Check the upstream-merge checklist in CLAUDE.md.`
        );
    } catch (err) {
        log.warn(
            'Could not read src/stores/vrcx.js for the schema version',
            err
        );
    }
    return fallback;
}

/**
 * @typedef {object} DatabaseHandle
 * @property {string} databasePath
 * @property {SQLiteShim} sqlite
 * @property {Record<string, Function>} database the ~190-method repository facade
 * @property {{ userId: string, userPrefix: string, maxTableSize: number, searchTableSize: number }} dbVars
 * @property {any} configRepository
 * @property {() => void} close
 */

/**
 * @param {{ readOnly?: boolean, create?: boolean, databasePath?: string }} [options]
 * @returns {Promise<DatabaseHandle>}
 */
export async function openDatabase(options = {}) {
    const resolved = resolveDatabasePath();
    const databasePath = options.databasePath
        ? path.resolve(options.databasePath)
        : resolved.databasePath;

    if (!existsSync(databasePath)) {
        if (options.create === false) {
            throw new Error(
                `No VRCX database at ${databasePath} (${resolved.source}). ` +
                    'Set VRCX_DATABASE or VRCX_DATA_DIR to point at an existing install.'
            );
        }
        mkdirSync(path.dirname(databasePath), { recursive: true });
        log.info(`Creating a new database at ${databasePath}`);
    }

    const sqlite = new SQLiteShim().open(databasePath, {
        readOnly: options.readOnly === true
    });
    installSQLiteGlobal(sqlite);

    // Imported *after* `window.SQLite` exists. These are the real upstream
    // modules; the alias map in server/aliases.js swaps out their browser-only
    // dependencies at resolution time.
    const { database, dbVars } =
        await import('../../src/services/database/index.js');
    const { default: configRepository } =
        await import('../../src/services/config.js');
    installFeedDedup(database, dbVars);

    return {
        databasePath,
        sqlite,
        database,
        dbVars,
        configRepository,
        close: () => sqlite.close()
    };
}

/**
 * Runs the same sequence the desktop app runs at boot
 * (src/stores/vrcx.js:updateDatabaseVersion), minus the UI.
 *
 * @param {DatabaseHandle} handle
 * @param {{ userId?: string }} [options] when given, also creates that account's
 *   per-user prefixed tables, as the desktop app does after login.
 * @returns {Promise<{ fromVersion: number, toVersion: number, migrated: boolean }>}
 */
export async function migrate(handle, options = {}) {
    const { database, configRepository } = handle;
    const toVersion = readTargetDatabaseVersion();

    await configRepository.init();
    const fromVersion = await configRepository.getInt(
        'VRCX_databaseVersion',
        0
    );

    if (options.userId) {
        // `upgradeDatabaseVersion` discovers per-user tables via `sqlite_schema`
        // LIKE queries, so existing accounts migrate without this. It is needed
        // only to create tables for an account the DB has never seen.
        await database.initUserTables(options.userId);
    }

    if (fromVersion >= toVersion) {
        log.info(`Database already at version ${fromVersion}; nothing to do.`);
        return { fromVersion, toVersion, migrated: false };
    }

    log.info(`Updating database from ${fromVersion} to ${toVersion}...`);
    await database.upgradeDatabaseVersion();
    await database.vacuum();
    await database.optimize();
    await configRepository.setInt('VRCX_databaseVersion', toVersion);
    log.info('Database update complete.');

    return { fromVersion, toVersion, migrated: true };
}
