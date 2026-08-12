#!/usr/bin/env node
/**
 * Phase 1 CLI. Enough to prove the server owns the database; the `serve`
 * command arrives in phase 3.
 *
 * Always run through the loader:
 *   node --import ./server/register-hooks.mjs server/src/cli.js <command>
 * or, from server/:  npm run cli -- <command>
 */
import { openDatabase, migrate, readTargetDatabaseVersion } from './db.js';
import { log } from './log.js';
import { resolveDatabasePath } from './paths.js';

const USAGE = `vrcx-headless server (phase 1)

Usage: cli.js <command> [options]

Commands:
  info                 Show where the database lives and what version it is
  migrate [--user=ID]  Run the JS migration layer against the database
  tables               Print row counts for the main tables
  query <sql>          Run a read-only SQL query and print positional rows

Options:
  --db=PATH            Use this database file instead of the resolved one
  --user=ID            VRChat user id, for per-user table creation
  --create             Allow creating the database if it does not exist

Environment:
  VRCX_DATABASE        Absolute path to VRCX.sqlite3
  VRCX_DATA_DIR        VRCX app data directory
  VRCX_LOG_LEVEL       debug | info | warn | error   (default: info)
`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const flags = {};
    const positional = [];
    for (const arg of argv) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            flags[key] = value ?? true;
        } else {
            positional.push(arg);
        }
    }
    return { flags, positional };
}

async function main() {
    const { flags, positional } = parseArgs(process.argv.slice(2));
    const command = positional[0];

    if (!command || flags.help) {
        console.log(USAGE);
        return 0;
    }

    const openOptions = {
        databasePath: typeof flags.db === 'string' ? flags.db : undefined,
        create: flags.create === true || command === 'migrate',
        readOnly: command === 'query' || command === 'tables'
    };

    if (command === 'info') {
        const resolved = resolveDatabasePath();
        const handle = await openDatabase({ ...openOptions, create: false });
        await handle.configRepository.init();
        const version = await handle.configRepository.getInt(
            'VRCX_databaseVersion',
            0
        );
        const tables = handle.sqlite.Execute(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'"
        );
        console.log(`app data directory : ${resolved.appDataDirectory}`);
        console.log(`database           : ${handle.databasePath}`);
        console.log(
            `resolved via       : ${openOptions.databasePath ? '--db argument' : resolved.source}`
        );
        console.log(
            `schema version     : ${version} (target ${readTargetDatabaseVersion()})`
        );
        console.log(`tables             : ${tables[0]?.[0] ?? 0}`);
        handle.close();
        return 0;
    }

    if (command === 'migrate') {
        const handle = await openDatabase(openOptions);
        const result = await migrate(handle, {
            userId: typeof flags.user === 'string' ? flags.user : undefined
        });
        handle.close();
        console.log(
            result.migrated
                ? `Migrated ${result.fromVersion} -> ${result.toVersion}`
                : `Already at version ${result.fromVersion}`
        );
        return 0;
    }

    if (command === 'tables') {
        const handle = await openDatabase({ ...openOptions, create: false });
        const names = handle.sqlite
            .Execute(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
            .map((row) => String(row[0]));
        for (const name of names) {
            const count = handle.sqlite.Execute(
                `SELECT COUNT(*) FROM "${name.replaceAll('"', '""')}"`
            );
            console.log(`${String(count[0]?.[0] ?? 0).padStart(9)}  ${name}`);
        }
        handle.close();
        return 0;
    }

    if (command === 'query') {
        const sql = positional.slice(1).join(' ');
        if (!sql) {
            console.error('query requires a SQL statement');
            return 2;
        }
        const handle = await openDatabase({ ...openOptions, create: false });
        for (const row of handle.sqlite.Execute(sql)) {
            console.log(JSON.stringify(row));
        }
        handle.close();
        return 0;
    }

    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    return 2;
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        // The stack is noise for expected conditions like "no database here";
        // VRCX_LOG_LEVEL=debug brings it back.
        log.error(err.message);
        log.debug('stack', err.stack);
        process.exit(1);
    });
