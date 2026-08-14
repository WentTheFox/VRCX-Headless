#!/usr/bin/env node
/**
 * Database maintenance plus the VRChat session commands. The VRChat-session
 * commands (`login`, `whoami`, `logout`, `pipeline`) drive the real reactive
 * stores (`src/stores/auth.js`, `src/services/websocket.js`) via
 * `./session.js`, not a bespoke scaffold — see phase 2b step 7 in CLAUDE.md
 * for why that's worth calling out. The HTTP `serve` command arrives in
 * phase 3.
 *
 * Always run through the loader:
 *   node --import ./server/register-hooks.mjs server/src/cli.js <command>
 * or, from the repo root:  npm run server -- <command>
 */
import { readFileSync } from 'node:fs';

import { mountHeadlessApp } from './app.js';
import { migrate, openDatabase, readTargetDatabaseVersion } from './db.js';
import { buildUserAgent, readVersion } from './globals.js';
import { setServerPassword } from './http-auth.js';
import { createHttpServer } from './http-server.js';
import { log } from './log.js';
import { resolveDatabasePath } from './paths.js';
import { ask, askHidden } from './prompt.js';
import {
    loginWithCredentials,
    logoutSession,
    restoreSession,
    waitForPipelineConnected,
    wsState
} from './session.js';
import { installWebApi } from './webapi-init.js';

import { AppDebug } from '../../src/services/appConfig.js';

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

Transport:
  set-password         Set the password that protects the HTTP/WS server
  serve                Start the HTTP/WS server (password auth, /api/rpc,
                        /api/stream) and the updateLoop daemon

Options:
  --db=PATH            Use this database file instead of the resolved one
  --user=ID            VRChat user id, for per-user table creation
  --create             Allow creating the database if it does not exist
  --username=NAME      Skip the username prompt
  --endpoint=URL       Custom API endpoint
  --websocket=URL      Custom pipeline endpoint
  --tls-cert=PATH      PEM certificate file, for \`serve\` over HTTPS
  --tls-key=PATH       PEM private key file, for \`serve\` over HTTPS

Environment:
  VRCX_DATABASE        Absolute path to VRCX.sqlite3
  VRCX_DATA_DIR        VRCX app data directory
  VRCX_LOG_LEVEL       debug | info | warn | error   (default: info)
  VRCHAT_PASSWORD      Password for a non-interactive login
  VRCHAT_2FA_CODE      Two-factor code for a non-interactive login
  VRCX_SERVER_PASSWORD Password for \`serve\`, instead of \`set-password\`
  VRCX_SERVER_HOST     HTTP/WS bind address                (default: 0.0.0.0)
  VRCX_SERVER_PORT     HTTP/WS bind port                   (default: 9000)
  VRCX_SERVER_TLS_CERT PEM certificate file, instead of --tls-cert
  VRCX_SERVER_TLS_KEY  PEM private key file, instead of --tls-key

  Both a cert and a key are required to serve over HTTPS; \`serve\` refuses
  to start on a partial pair rather than silently falling back to HTTP.
  Without either, \`serve\` stays plain HTTP — put a reverse proxy in front
  for TLS instead, or provide both here directly.
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
 * Everything the VRChat-session commands need: `window.SQLite` (via
 * `openDatabase`, already done by the caller), `window.WebApi`, and the
 * mounted app so `login()`/`autoLoginAfterMounted()`/etc. can actually run.
 *
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<Awaited<ReturnType<typeof mountHeadlessApp>>>}
 */
async function bootstrapSession(handle) {
    installWebApi(handle, { userAgent: buildUserAgent(readVersion()) });
    return mountHeadlessApp();
}

/**
 * Reads `--tls-cert`/`--tls-key` (or their env var equivalents) into PEM
 * file contents for `createHttpServer`'s `tls` option. A cert with no key
 * (or vice versa) is a config mistake, not a fallback-to-HTTP situation —
 * `serve` should refuse to start rather than silently serve plaintext when
 * the operator clearly intended HTTPS.
 *
 * @param {Record<string, any>} flags
 * @returns {{ cert: Buffer, key: Buffer } | undefined}
 */
function resolveTlsOptions(flags) {
    const certPath =
        typeof flags['tls-cert'] === 'string'
            ? flags['tls-cert']
            : process.env.VRCX_SERVER_TLS_CERT;
    const keyPath =
        typeof flags['tls-key'] === 'string'
            ? flags['tls-key']
            : process.env.VRCX_SERVER_TLS_KEY;

    if (!certPath && !keyPath) {
        return undefined;
    }
    if (!certPath || !keyPath) {
        throw new Error(
            'Both a TLS certificate and key are required for HTTPS (--tls-cert/--tls-key or VRCX_SERVER_TLS_CERT/VRCX_SERVER_TLS_KEY) — only one was given.'
        );
    }
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {Record<string, any>} flags
 */
async function runLogin(handle, flags) {
    const username =
        typeof flags.username === 'string'
            ? flags.username
            : await ask('VRChat username or email: ');
    const password =
        process.env.VRCHAT_PASSWORD ?? (await askHidden('VRChat password: '));

    if (!username || !password) {
        throw new Error('A username and password are required');
    }

    const { stores } = await bootstrapSession(handle);
    const user = await loginWithCredentials(stores, {
        username,
        password,
        endpoint: typeof flags.endpoint === 'string' ? flags.endpoint : '',
        websocket: typeof flags.websocket === 'string' ? flags.websocket : ''
    });

    console.log(`Logged in as ${user.displayName} (${user.id})`);
    return 0;
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
            const { stores } = await bootstrapSession(handle);
            const user = await restoreSession(stores);
            if (!user?.id) {
                throw new Error(
                    'Not logged in, or the stored session is no longer valid. Run `login`.'
                );
            }
            console.log(`${user.displayName} (${user.id})`);
            console.log(`status   : ${user.status ?? 'unknown'}`);
            console.log(`friends  : ${user.friends?.length ?? 0}`);
            console.log(`endpoint : ${AppDebug.endpointDomain}`);
            return 0;
        } finally {
            handle.close();
        }
    }

    if (command === 'logout') {
        const handle = await openDatabase({ ...openOptions, create: false });
        try {
            const { stores } = await bootstrapSession(handle);
            await logoutSession(stores);
            console.log('Logged out; saved credentials kept.');
            return 0;
        } finally {
            handle.close();
        }
    }

    if (command === 'pipeline') {
        const handle = await openDatabase({ ...openOptions, create: false });
        const { stores } = await bootstrapSession(handle);
        const user = await restoreSession(stores);
        if (!user?.id) {
            throw new Error(
                'Not logged in, or the stored session is no longer valid. Run `login`.'
            );
        }
        await waitForPipelineConnected();
        // Real self-rescheduling daemon loop (phase 2b step 8): friend/group
        // refresh, DB optimize, etc. Started here rather than in
        // bootstrapSession/mountHeadlessApp, since one-shot commands
        // (login/whoami/logout) have no use for a recurring timer that
        // outlives them by one tick before the process exits anyway.
        stores.updateLoop.updateLoop();
        console.log('Streaming pipeline events. Press Ctrl-C to stop.');
        let lastMessageCount = wsState.messageCount;
        const interval = setInterval(() => {
            if (wsState.messageCount === lastMessageCount) return;
            lastMessageCount = wsState.messageCount;
            console.log(`pipeline messages received: ${wsState.messageCount}`);
        }, 1000);
        await new Promise((resolve) => {
            process.on('SIGINT', resolve);
            process.on('SIGTERM', resolve);
        });
        clearInterval(interval);
        handle.close();
        console.log(
            `\nReceived ${wsState.messageCount} events (${wsState.bytesReceived} bytes)`
        );
        return 0;
    }

    if (command === 'set-password') {
        const handle = await openDatabase({ ...openOptions, create: false });
        try {
            const password = await askHidden('New server password: ');
            if (!password) {
                throw new Error('A password is required');
            }
            const confirmation = await askHidden('Confirm password: ');
            if (confirmation !== password) {
                throw new Error('Passwords did not match');
            }
            await setServerPassword(handle, password);
            console.log('Server password set.');
            return 0;
        } finally {
            handle.close();
        }
    }

    if (command === 'serve') {
        const tls = resolveTlsOptions(flags);
        const handle = await openDatabase({ ...openOptions, create: false });
        const { stores } = await bootstrapSession(handle);

        const user = await restoreSession(stores).catch(() => null);
        if (user?.id) {
            await waitForPipelineConnected().catch((err) => {
                log.warn('Pipeline did not connect', { message: err.message });
            });
            stores.updateLoop.updateLoop();
        } else {
            log.warn(
                'Not logged in to VRChat; serving db/config RPC only. Run `login` for the pipeline stream.'
            );
        }

        const { server, streamClientCount, useHttps } = await createHttpServer(
            handle,
            { tls }
        );
        const host = process.env.VRCX_SERVER_HOST || '0.0.0.0';
        const port = Number(process.env.VRCX_SERVER_PORT) || 9000;

        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, resolve);
        });
        console.log(
            `Serving on ${useHttps ? 'https' : 'http'}://${host}:${port}. Press Ctrl-C to stop.`
        );

        await new Promise((resolve) => {
            process.on('SIGINT', resolve);
            process.on('SIGTERM', resolve);
        });

        console.log(
            `\nShutting down (${streamClientCount()} stream client(s) connected).`
        );
        await new Promise((resolve) => server.close(resolve));
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
