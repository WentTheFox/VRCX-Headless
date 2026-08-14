/**
 * TOTP secret source precedence and session token lifecycle for the phase 3
 * HTTP/WS transport (`server/src/http-auth.js`). The TOTP algorithm itself
 * (RFC 6238 test vectors etc.) is covered by `totp.test.js` — this file is
 * about the *source precedence* (env var vs. stored secret) and sessions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db.js';
import {
    checkTotpCode,
    createSession,
    destroySession,
    hasServerTotp,
    readSessionCookie,
    readSessionToken,
    setServerTotp,
    validateSession
} from '../src/http-auth.js';
import { generateTotpCode, generateTotpSecret } from '../src/totp.js';

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

describe('readSessionToken', () => {
    /**
     * @param {Record<string, string | undefined>} headers
     * @returns {import('node:http').IncomingMessage}
     */
    function fakeRequest(headers) {
        return /** @type {any} */ ({ headers });
    }

    it('prefers the Authorization: Bearer header over a cookie', () => {
        expect(
            readSessionToken(
                fakeRequest({
                    authorization: 'Bearer from-header',
                    cookie: 'vrcx_session=from-cookie'
                })
            )
        ).toBe('from-header');
    });

    it('falls back to the cookie when there is no Authorization header', () => {
        expect(
            readSessionToken(fakeRequest({ cookie: 'vrcx_session=from-cookie' }))
        ).toBe('from-cookie');
    });

    it('ignores a non-Bearer Authorization header', () => {
        expect(
            readSessionToken(
                fakeRequest({
                    authorization: 'Basic dXNlcjpwYXNz',
                    cookie: 'vrcx_session=from-cookie'
                })
            )
        ).toBe('from-cookie');
    });

    it('returns undefined when neither is present', () => {
        expect(readSessionToken(fakeRequest({}))).toBeUndefined();
    });
});

describe('TOTP secret source precedence', () => {
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
        delete process.env.VRCX_SERVER_TOTP_SECRET;
    });

    it('reports no secret configured until one is set', async () => {
        expect(await hasServerTotp(handle)).toBe(false);
        expect(await checkTotpCode(handle, '123456')).toBe(false);
    });

    it('accepts a code generated from a secret set via setServerTotp', async () => {
        const secret = generateTotpSecret();
        await setServerTotp(handle, secret);
        expect(await hasServerTotp(handle)).toBe(true);
        expect(await checkTotpCode(handle, generateTotpCode(secret))).toBe(
            true
        );
        expect(await checkTotpCode(handle, '000000')).toBe(false);
    });

    it('prefers VRCX_SERVER_TOTP_SECRET over the stored secret', async () => {
        const storedSecret = generateTotpSecret();
        const envSecret = generateTotpSecret();
        await setServerTotp(handle, storedSecret);
        process.env.VRCX_SERVER_TOTP_SECRET = envSecret;
        expect(
            await checkTotpCode(handle, generateTotpCode(storedSecret))
        ).toBe(false);
        expect(await checkTotpCode(handle, generateTotpCode(envSecret))).toBe(
            true
        );
    });
});
