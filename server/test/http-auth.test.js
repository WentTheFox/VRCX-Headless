/**
 * Password hashing, password source precedence, and session token
 * lifecycle for the phase 3 HTTP/WS transport (`server/src/http-auth.js`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db.js';
import {
    checkPassword,
    createSession,
    destroySession,
    hasServerPassword,
    hashPassword,
    readSessionCookie,
    setServerPassword,
    validateSession,
    verifyPassword
} from '../src/http-auth.js';

describe('hashPassword / verifyPassword', () => {
    it('round-trips a correct password', () => {
        const stored = hashPassword('correct horse battery staple');
        expect(verifyPassword('correct horse battery staple', stored)).toBe(
            true
        );
    });

    it('rejects a wrong password', () => {
        const stored = hashPassword('correct horse battery staple');
        expect(verifyPassword('wrong password', stored)).toBe(false);
    });

    it('salts each hash differently', () => {
        const a = hashPassword('same password');
        const b = hashPassword('same password');
        expect(a).not.toBe(b);
        expect(verifyPassword('same password', a)).toBe(true);
        expect(verifyPassword('same password', b)).toBe(true);
    });

    it('rejects a malformed stored value instead of throwing', () => {
        expect(verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
        expect(verifyPassword('anything', '')).toBe(false);
    });
});

describe('session tokens', () => {
    it('validates a token it created and rejects an unknown one', () => {
        const token = createSession();
        expect(validateSession(token)).toBe(true);
        expect(validateSession('not-a-real-token')).toBe(false);
        expect(validateSession(undefined)).toBe(false);
    });

    it('invalidates a token after destroySession', () => {
        const token = createSession();
        destroySession(token);
        expect(validateSession(token)).toBe(false);
    });
});

describe('readSessionCookie', () => {
    it('finds the session cookie among others', () => {
        expect(
            readSessionCookie('other=1; vrcx_session=abc123; another=2')
        ).toBe('abc123');
    });

    it('returns undefined when absent', () => {
        expect(readSessionCookie('other=1')).toBeUndefined();
        expect(readSessionCookie(undefined)).toBeUndefined();
    });
});

describe('password source precedence', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;

    beforeAll(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'vrcx-headless-http-auth-'));
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
        // `configRepository.setString` needs the `configs` table; `.init()`
        // creates just that (CREATE TABLE IF NOT EXISTS), same as
        // server/src/cli.js's `info` command does, without running the full
        // migration these tests have no other need for.
        await handle.configRepository.init();
    });

    afterAll(() => {
        handle?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
        delete process.env.VRCX_SERVER_PASSWORD;
    });

    it('reports no password configured until one is set', async () => {
        expect(await hasServerPassword(handle)).toBe(false);
        expect(await checkPassword(handle, 'anything')).toBe(false);
    });

    it('accepts a password set via setServerPassword', async () => {
        await setServerPassword(handle, 'stored-password');
        expect(await hasServerPassword(handle)).toBe(true);
        expect(await checkPassword(handle, 'stored-password')).toBe(true);
        expect(await checkPassword(handle, 'wrong')).toBe(false);
    });

    it('prefers VRCX_SERVER_PASSWORD over the stored hash', async () => {
        await setServerPassword(handle, 'stored-password');
        process.env.VRCX_SERVER_PASSWORD = 'env-password';
        expect(await checkPassword(handle, 'stored-password')).toBe(false);
        expect(await checkPassword(handle, 'env-password')).toBe(true);
    });
});
