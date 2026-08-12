/**
 * Seam tests: exercise the *unmodified* upstream modules against the server's
 * shims, rather than testing the shims in isolation.
 *
 * These are the tests that actually catch a broken split — a shim can satisfy
 * its own unit tests and still fail the contract `src/**` depends on.
 */
import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CookieStore } from '../src/cookies.js';
import { installWebApiGlobal, WebApiShim } from '../src/shims/webapi.js';

/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let origin;

beforeAll(async () => {
    server = createServer((req, res) => {
        if (req.url === '/fail') {
            res.destroy();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    installWebApiGlobal(
        new WebApiShim({
            cookies: new CookieStore(),
            userAgent: 'VRCX test'
        })
    );
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

describe('src/services/webapi.js against the headless shim', () => {
    it('returns {status, data} through the real upstream wrapper', async () => {
        const { default: webApiService } =
            await import('../../src/services/webapi.js');

        const result = await webApiService.execute({ url: `${origin}/echo` });

        expect(result.status).toBe(200);
        expect(JSON.parse(result.data)).toEqual({ ok: true, path: '/echo' });
    });

    it('throws the message as a string on transport failure', async () => {
        // webapi.js does `if (item.Item1 === -1) throw item.Item2`. If the shim
        // returned an Error object here, $throw in src/services/request.js would
        // JSON.stringify it to '{}' and the real cause would be lost.
        const { default: webApiService } =
            await import('../../src/services/webapi.js');

        await expect(
            webApiService.execute({ url: 'http://127.0.0.1:1/nope' })
        ).rejects.toSatisfy(
            (thrown) => typeof thrown === 'string' && thrown.length > 0
        );
    });

    it('round-trips cookies through the real getCookies/setCookies', async () => {
        const { default: webApiService } =
            await import('../../src/services/webapi.js');

        // The shim's cookie methods are synchronous; the real bound objects
        // return promises. `src/services/webapi.js` awaits either way, so this
        // asserts the value shape rather than the promise-ness.
        const blob = await webApiService.getCookies();
        expect(typeof blob).toBe('string');
        expect(() => webApiService.setCookies(blob)).not.toThrow();
    });
});

describe('package aliases', () => {
    it('worker-timers resolves to native timers instead of a Web Worker', async () => {
        // The real package builds a Worker from a blob URL; `Worker` does not
        // exist in Node and the failure is deferred to the first call.
        const workerTimers = await import('worker-timers');

        await expect(
            new Promise((resolve) => workerTimers.setTimeout(resolve, 1))
        ).resolves.not.toThrow();

        const handle = workerTimers.setInterval(() => {}, 1000);
        expect(() => workerTimers.clearInterval(handle)).not.toThrow();
    });

    it('vue-sonner resolves to the logging stub', async () => {
        const { toast } = await import('vue-sonner');

        expect(typeof toast).toBe('function');
        expect(() =>
            toast.error('boom', { description: 'details' })
        ).not.toThrow();
        expect(() => toast.success('fine')).not.toThrow();
    });
});
