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
    return { status: response.status, body: await response.json() };
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
