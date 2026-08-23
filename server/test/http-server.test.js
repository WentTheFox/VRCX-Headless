/**
 * Integration coverage for `server/src/http-server.js`'s routes against a
 * real listening server — `rpc.test.js`/`http-auth.test.js` cover the
 * dispatch/auth logic in isolation, this is what actually wires them
 * together correctly over real HTTP.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/db.js';
import { setServerTotp } from '../src/http-auth.js';
import { createHttpServer } from '../src/http-server.js';
import { generateTotpCode, generateTotpSecret } from '../src/totp.js';

/**
 * @param {string} suffix
 * @returns {Promise<{ dir: string, handle: any, server: import('node:http').Server, origin: string }>}
 */
async function startServer(suffix) {
    const dir = mkdtempSync(
        path.join(tmpdir(), `vrcx-headless-http-server-${suffix}-`)
    );
    const handle = await openDatabase({
        databasePath: path.join(dir, 'VRCX.sqlite3'),
        create: true
    });
    await handle.configRepository.init();
    const secret = generateTotpSecret();
    await setServerTotp(handle, secret);

    const { server } = await createHttpServer(handle);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { dir, handle, server, origin, secret };
}

/**
 * @param {string} origin
 * @param {string} path
 * @param {any} body
 * @param {Record<string, string>} [headers]
 */
async function post(origin, path, body, headers = {}) {
    const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    return {
        status: response.status,
        body: await response.json(),
        setCookie: response.headers.get('set-cookie')
    };
}

describe('/api/login', () => {
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let ctx;

    beforeAll(async () => {
        ctx = await startServer('login');
    });

    afterAll(async () => {
        await new Promise((resolve) => ctx.server.close(resolve));
        ctx.handle.close();
        rmSync(ctx.dir, { recursive: true, force: true });
    });

    it('rejects a missing code', async () => {
        const { status, body } = await post(ctx.origin, '/api/login', {});
        expect(status).toBe(400);
        expect(body.ok).toBe(false);
    });

    it('rejects a wrong code', async () => {
        const { status, body } = await post(ctx.origin, '/api/login', {
            code: '000000'
        });
        expect(status).toBe(401);
        expect(body.ok).toBe(false);
    });

    it('accepts the current code and returns a session token', async () => {
        const { status, body } = await post(ctx.origin, '/api/login', {
            code: generateTotpCode(ctx.secret)
        });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(typeof body.token).toBe('string');
    });
});

describe('/api/totp/setup + /api/totp/confirm — already configured', () => {
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let ctx;

    beforeAll(async () => {
        ctx = await startServer('configured');
    });

    afterAll(async () => {
        await new Promise((resolve) => ctx.server.close(resolve));
        ctx.handle.close();
        rmSync(ctx.dir, { recursive: true, force: true });
    });

    // Deliberately one-shot: once a secret exists, neither route works at
    // all, authenticated or not. Rotating is setup-totp-CLI-only, so the
    // browser never gets a second chance to see the secret/QR.
    it('setup is refused, even with a valid session', async () => {
        const login = await post(ctx.origin, '/api/login', {
            code: generateTotpCode(ctx.secret)
        });
        const { status, body } = await post(
            ctx.origin,
            '/api/totp/setup',
            {},
            { Authorization: `Bearer ${login.body.token}` }
        );
        expect(status).toBe(403);
        expect(body.ok).toBe(false);
    });

    it('confirm is refused, even with a valid session and a correct code', async () => {
        const login = await post(ctx.origin, '/api/login', {
            code: generateTotpCode(ctx.secret)
        });
        const otherSecret = generateTotpSecret();
        const { status, body } = await post(
            ctx.origin,
            '/api/totp/confirm',
            { secret: otherSecret, code: generateTotpCode(otherSecret) },
            { Authorization: `Bearer ${login.body.token}` }
        );
        expect(status).toBe(403);
        expect(body.ok).toBe(false);

        // The original secret must still be the only one that works.
        const stillWorks = await post(ctx.origin, '/api/login', {
            code: generateTotpCode(ctx.secret)
        });
        expect(stillWorks.status).toBe(200);
    });
});

describe('/api/totp/setup + /api/totp/confirm — first-run enrollment', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;
    /** @type {import('node:http').Server} */
    let server;
    /** @type {string} */
    let origin;

    beforeAll(async () => {
        // No setServerTotp call here — this database genuinely has no
        // secret configured yet, the real state `serve` starts in before
        // anyone has ever run setup-totp or used the browser flow.
        dir = mkdtempSync(
            path.join(tmpdir(), 'vrcx-headless-http-server-unconfigured-')
        );
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
        await handle.configRepository.init();
        ({ server } = await createHttpServer(handle));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        handle.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('setup needs no auth and returns a fresh secret + provisioning URI', async () => {
        const { status, body } = await post(origin, '/api/totp/setup', {});
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(typeof body.secret).toBe('string');
        expect(body.uri.startsWith('otpauth://totp/')).toBe(true);
    });

    it('confirm rejects an invalid code without persisting anything', async () => {
        const setup = await post(origin, '/api/totp/setup', {});
        const { status, body } = await post(origin, '/api/totp/confirm', {
            secret: setup.body.secret,
            code: '000000'
        });
        expect(status).toBe(400);
        expect(body.ok).toBe(false);

        // Still unconfigured -- setup should still be reachable.
        const setupAgain = await post(origin, '/api/totp/setup', {});
        expect(setupAgain.status).toBe(200);
    });

    it('confirm with the correct code enrolls and returns a session, closing the door on any further setup', async () => {
        const setup = await post(origin, '/api/totp/setup', {});
        const confirm = await post(origin, '/api/totp/confirm', {
            secret: setup.body.secret,
            code: generateTotpCode(setup.body.secret)
        });
        expect(confirm.status).toBe(200);
        expect(confirm.body.ok).toBe(true);
        expect(typeof confirm.body.token).toBe('string');

        // Now configured: the new secret logs in for real...
        const login = await post(origin, '/api/login', {
            code: generateTotpCode(setup.body.secret)
        });
        expect(login.status).toBe(200);

        // ...and setup/confirm are both refused from here on, permanently
        // (this is the "one-shot" behaviour the previous describe block
        // exercises against a server that started already-configured).
        const setupAfter = await post(origin, '/api/totp/setup', {});
        expect(setupAfter.status).toBe(403);
    });
});

describe('/api/session/refresh', () => {
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let ctx;

    beforeAll(async () => {
        ctx = await startServer('session-refresh');
    });

    afterAll(async () => {
        await new Promise((resolve) => ctx.server.close(resolve));
        ctx.handle.close();
        rmSync(ctx.dir, { recursive: true, force: true });
    });

    it('rejects without a valid session', async () => {
        const { status, body } = await post(
            ctx.origin,
            '/api/session/refresh',
            {}
        );
        expect(status).toBe(401);
        expect(body.ok).toBe(false);
    });

    it('rotates a valid token into a new one, revoking the old one', async () => {
        const login = await post(ctx.origin, '/api/login', {
            code: generateTotpCode(ctx.secret)
        });
        const oldToken = login.body.token;

        const refresh = await post(
            ctx.origin,
            '/api/session/refresh',
            {},
            { Authorization: `Bearer ${oldToken}` }
        );
        expect(refresh.status).toBe(200);
        expect(refresh.body.ok).toBe(true);
        expect(typeof refresh.body.token).toBe('string');
        expect(refresh.body.token).not.toBe(oldToken);

        const rpcArgs = {
            target: 'config',
            method: 'getString',
            args: ['lastUserLoggedIn', '']
        };
        const rpcWithOldToken = await post(ctx.origin, '/api/rpc', rpcArgs, {
            Authorization: `Bearer ${oldToken}`
        });
        expect(rpcWithOldToken.status).toBe(401);

        const rpcWithNewToken = await post(ctx.origin, '/api/rpc', rpcArgs, {
            Authorization: `Bearer ${refresh.body.token}`
        });
        expect(rpcWithNewToken.status).toBe(200);
    });
});

describe('/api/rpc — Map/Set return values survive the JSON round trip', () => {
    // Regression coverage for a real live bug (2026-08-23):
    // PreviousInstancesInfoDialog.vue's table view calls
    // database.getPlayersFromInstance() (a real Map) and does
    // Array.from(data.values()) expecting Map#values() — flattening the
    // Map to a bare [key, value][] array on the wire (the original fix for
    // "Map serializes to {}") made Array#values() yield the [key, value]
    // pairs themselves instead, so every row lost its own properties. This
    // asserts the wire shape client-side revival (rpc-client.js,
    // agent-rpc.js) depends on: a tagged {__rpcType, entries} object, not
    // a bare array.
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let ctx;
    /** @type {string} */
    let token;

    beforeAll(async () => {
        ctx = await startServer('rpc-map-set');
        const login = await post(ctx.origin, '/api/login', {
            code: generateTotpCode(ctx.secret)
        });
        token = login.body.token;
    });

    afterAll(async () => {
        await new Promise((resolve) => ctx.server.close(resolve));
        ctx.handle.close();
        rmSync(ctx.dir, { recursive: true, force: true });
    });

    it('tags a Map result with its entries, not a bare array', async () => {
        ctx.handle.database.__testReturnsMap = async () =>
            new Map([
                ['alice', { displayName: 'alice', time: 42 }],
                ['bob', { displayName: 'bob', time: 7 }]
            ]);

        const { status, body } = await post(
            ctx.origin,
            '/api/rpc',
            { target: 'db', method: '__testReturnsMap', args: [] },
            { Authorization: `Bearer ${token}` }
        );

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result.__rpcType).toBe('Map');
        expect(body.result.entries).toEqual([
            ['alice', { displayName: 'alice', time: 42 }],
            ['bob', { displayName: 'bob', time: 7 }]
        ]);

        delete ctx.handle.database.__testReturnsMap;
    });

    it('tags a Set result with its values, not a bare array', async () => {
        ctx.handle.database.__testReturnsSet = async () =>
            new Set(['alice', 'bob']);

        const { status, body } = await post(
            ctx.origin,
            '/api/rpc',
            { target: 'db', method: '__testReturnsSet', args: [] },
            { Authorization: `Bearer ${token}` }
        );

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result.__rpcType).toBe('Set');
        expect(body.result.values).toEqual(['alice', 'bob']);

        delete ctx.handle.database.__testReturnsSet;
    });
});

describe('/api/web/* — cookie-only mirrors never expose the raw token', () => {
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let ctx;

    beforeAll(async () => {
        ctx = await startServer('web-cookie-only');
    });

    afterAll(async () => {
        await new Promise((resolve) => ctx.server.close(resolve));
        ctx.handle.close();
        rmSync(ctx.dir, { recursive: true, force: true });
    });

    it('/api/web/login sets a session cookie but never returns the token', async () => {
        const { status, body, setCookie } = await post(
            ctx.origin,
            '/api/web/login',
            { code: generateTotpCode(ctx.secret) }
        );
        expect(status).toBe(200);
        expect(body).toEqual({ ok: true });
        expect(body.token).toBeUndefined();
        expect(setCookie).toMatch(
            /^vrcx_session=.+; HttpOnly; SameSite=Strict; Path=\//
        );
    });

    it('the cookie from /api/web/login actually authenticates /api/rpc', async () => {
        const login = await post(ctx.origin, '/api/web/login', {
            code: generateTotpCode(ctx.secret)
        });
        const cookie = login.setCookie.split(';')[0];
        const rpc = await post(
            ctx.origin,
            '/api/rpc',
            {
                target: 'config',
                method: 'getString',
                args: ['lastUserLoggedIn', '']
            },
            { Cookie: cookie }
        );
        expect(rpc.status).toBe(200);
    });

    it('/api/web/session/refresh rotates the cookie without ever returning a token', async () => {
        const login = await post(ctx.origin, '/api/web/login', {
            code: generateTotpCode(ctx.secret)
        });
        const oldCookie = login.setCookie.split(';')[0];

        const refresh = await post(
            ctx.origin,
            '/api/web/session/refresh',
            {},
            { Cookie: oldCookie }
        );
        expect(refresh.status).toBe(200);
        expect(refresh.body).toEqual({ ok: true });
        expect(refresh.body.token).toBeUndefined();
        const newCookie = refresh.setCookie.split(';')[0];
        expect(newCookie).not.toBe(oldCookie);

        // the old cookie is revoked, matching the bearer route's own behaviour
        const rpcWithOldCookie = await post(
            ctx.origin,
            '/api/rpc',
            {
                target: 'config',
                method: 'getString',
                args: ['lastUserLoggedIn', '']
            },
            { Cookie: oldCookie }
        );
        expect(rpcWithOldCookie.status).toBe(401);

        const rpcWithNewCookie = await post(
            ctx.origin,
            '/api/rpc',
            {
                target: 'config',
                method: 'getString',
                args: ['lastUserLoggedIn', '']
            },
            { Cookie: newCookie }
        );
        expect(rpcWithNewCookie.status).toBe(200);
    });

    it('/api/web/session/refresh rejects without a valid cookie', async () => {
        const { status, body } = await post(
            ctx.origin,
            '/api/web/session/refresh',
            {}
        );
        expect(status).toBe(401);
        expect(body.ok).toBe(false);
    });
});

describe('Secure cookie flag', () => {
    /** @type {Awaited<ReturnType<typeof startServer>>} */
    let ctx;

    beforeAll(async () => {
        ctx = await startServer('secure-cookie-plain');
    });

    afterAll(async () => {
        await new Promise((resolve) => ctx.server.close(resolve));
        ctx.handle.close();
        rmSync(ctx.dir, { recursive: true, force: true });
    });

    it('omits ; Secure on a plain-HTTP listener with no trust-proxy option', async () => {
        const { setCookie } = await post(ctx.origin, '/api/web/login', {
            code: generateTotpCode(ctx.secret)
        });
        expect(setCookie).not.toMatch(/; Secure/);
    });
});

describe('Secure cookie flag — trustProxy', () => {
    /** @type {string} */
    let dir;
    /** @type {Awaited<ReturnType<typeof openDatabase>>} */
    let handle;
    /** @type {import('node:http').Server} */
    let server;
    /** @type {string} */
    let origin;
    /** @type {string} */
    let secret;

    beforeAll(async () => {
        dir = mkdtempSync(
            path.join(tmpdir(), 'vrcx-headless-http-server-trust-proxy-')
        );
        handle = await openDatabase({
            databasePath: path.join(dir, 'VRCX.sqlite3'),
            create: true
        });
        await handle.configRepository.init();
        secret = generateTotpSecret();
        await setServerTotp(handle, secret);
        ({ server } = await createHttpServer(handle, { trustProxy: true }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
        handle.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('still omits ; Secure when the forwarded-proto header is absent', async () => {
        const { setCookie } = await post(origin, '/api/web/login', {
            code: generateTotpCode(secret)
        });
        expect(setCookie).not.toMatch(/; Secure/);
    });

    it('adds ; Secure when X-Forwarded-Proto: https is present, even though the listener itself is plain HTTP', async () => {
        const { setCookie } = await post(
            origin,
            '/api/web/login',
            { code: generateTotpCode(secret) },
            { 'X-Forwarded-Proto': 'https' }
        );
        expect(setCookie).toMatch(/; Secure/);
    });

    it('ignores a spoofed X-Forwarded-Proto for any value other than https', async () => {
        const { setCookie } = await post(
            origin,
            '/api/web/login',
            { code: generateTotpCode(secret) },
            { 'X-Forwarded-Proto': 'http' }
        );
        expect(setCookie).not.toMatch(/; Secure/);
    });
});
