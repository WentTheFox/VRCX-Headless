#!/usr/bin/env node
/**
 * Phase 2a CLI: database maintenance plus the VRChat session commands.
 * The HTTP `serve` command arrives in phase 3.
 *
 * Always run through the loader:
 *   node --import ./server/register-hooks.mjs server/src/cli.js <command>
 * or, from the repo root:  npm run server -- <command>
 */
import { migrate, openDatabase, readTargetDatabaseVersion } from './db.js';
import { readVersion } from './globals.js';
import { log } from './log.js';
import { resolveDatabasePath } from './paths.js';
import { ask, askHidden } from './prompt.js';
import { buildUserAgent, PipelineConnection, VRChatSession } from './vrchat.js';

const USAGE = `vrcx-headless server

Usage: cli.js <command> [options]

Database:
  info                 Show where the database lives and what version it is
  migrate [--user=ID]  Run the JS migration layer against the database
  tables               Print row counts for the main tables
  query <sql>          Run a read-only SQL query and print positional rows

VRChat session:
  login                Log in to VRChat (prompts for credentials and 2FA)
  whoami               Show the currently logged-in VRChat account
  logout               Clear the stored session (keeps saved credentials)
  pipeline             Connect to the VRChat event pipeline and stream events

Options:
  --db=PATH            Use this database file instead of the resolved one
  --user=ID            VRChat user id, for per-user table creation
  --create             Allow creating the database if it does not exist
  --username=NAME      Skip the username prompt
  --endpoint=URL       Custom API endpoint
  --websocket=URL      Custom pipeline endpoint

Environment:
  VRCX_DATABASE        Absolute path to VRCX.sqlite3
  VRCX_DATA_DIR        VRCX app data directory
  VRCX_LOG_LEVEL       debug | info | warn | error   (default: info)
  VRCHAT_PASSWORD      Password for a non-interactive login
  VRCHAT_2FA_CODE      Two-factor code for a non-interactive login
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

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {VRChatSession}
 */
function createSession(handle) {
    return new VRChatSession(handle, {
        userAgent: buildUserAgent(readVersion())
    });
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {Record<string, any>} flags
 */
async function runLogin(handle, flags) {
    const session = createSession(handle);
    session.useEndpoints({
        endpoint: typeof flags.endpoint === 'string' ? flags.endpoint : '',
        websocket: typeof flags.websocket === 'string' ? flags.websocket : ''
    });

    const username =
        typeof flags.username === 'string'
            ? flags.username
            : await ask('VRChat username or email: ');
    const password =
        process.env.VRCHAT_PASSWORD ?? (await askHidden('VRChat password: '));

    if (!username || !password) {
        throw new Error('A username and password are required');
    }

    // `GET config` first, matching the desktop app's order; it also seeds cookies.
    await session.getConfig();

    let json = await session.login(username, password);
    const twoFactorKind = VRChatSession.twoFactorKind(json);

    if (twoFactorKind) {
        const label =
            twoFactorKind === 'emailotp'
                ? 'Email one-time code: '
                : 'Authenticator code: ';
        const code = process.env.VRCHAT_2FA_CODE ?? (await ask(label));
        if (!code) {
            throw new Error('A two-factor code is required');
        }
        await session.verifyTwoFactor(twoFactorKind, code);
        json = await session.getCurrentUser();
    }

    if (!json?.id) {
        throw new Error(
            'Login did not return a user; check the username and password'
        );
    }

    await session.saveCredentials(json, {
        username,
        password,
        endpoint: typeof flags.endpoint === 'string' ? flags.endpoint : '',
        websocket: typeof flags.websocket === 'string' ? flags.websocket : ''
    });

    // The desktop app creates these after login; do the same so the account is
    // immediately usable.
    await handle.database.initUserTables(json.id);

    console.log(`Logged in as ${json.displayName} (${json.id})`);
    return 0;
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 */
async function requireSession(handle) {
    const session = createSession(handle);
    const restored = await session.loadLastSession();
    if (!restored) {
        throw new Error('Not logged in. Run `login` first.');
    }
    return { session, restored };
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
        const lastUser = await handle.configRepository.getString(
            'lastUserLoggedIn',
            ''
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
        console.log(`logged in as       : ${lastUser || '(nobody)'}`);
        console.log(`user agent         : ${buildUserAgent(readVersion())}`);
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

    if (command === 'login') {
        const handle = await openDatabase({ ...openOptions, create: false });
        try {
            return await runLogin(handle, flags);
        } finally {
            handle.close();
        }
    }

    if (command === 'whoami') {
        const handle = await openDatabase({ ...openOptions, create: false });
        try {
            const { session } = await requireSession(handle);
            const user = await session.getCurrentUser();
            if (!user?.id) {
                throw new Error(
                    'Stored session is no longer valid; log in again.'
                );
            }
            console.log(`${user.displayName} (${user.id})`);
            console.log(`status   : ${user.status ?? 'unknown'}`);
            console.log(`friends  : ${user.friends?.length ?? 0}`);
            console.log(`endpoint : ${session.endpoint}`);
            return 0;
        } finally {
            handle.close();
        }
    }

    if (command === 'logout') {
        const handle = await openDatabase({ ...openOptions, create: false });
        try {
            const session = createSession(handle);
            await session.logout();
            console.log('Logged out; saved credentials kept.');
            return 0;
        } finally {
            handle.close();
        }
    }

    if (command === 'pipeline') {
        const handle = await openDatabase({ ...openOptions, create: false });
        const { session } = await requireSession(handle);
        const pipeline = new PipelineConnection(session, {
            onEvent: (type) => console.log(`event: ${type}`)
        });
        await pipeline.connect();
        console.log('Streaming pipeline events. Press Ctrl-C to stop.');
        await new Promise((resolve) => {
            process.on('SIGINT', resolve);
            process.on('SIGTERM', resolve);
        });
        pipeline.close();
        handle.close();
        console.log(
            `\nReceived ${pipeline.stats.messageCount} events (${pipeline.stats.bytesReceived} chars)`
        );
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
