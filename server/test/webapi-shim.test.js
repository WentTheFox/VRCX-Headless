/**
 * Contract tests for the node:fetch implementation of `window.WebApi`.
 *
 * Each case pins a behaviour of Dotnet/WebApi.cs that the unmodified
 * `src/services/webapi.js` (and therefore `src/services/request.js`) relies on.
 */
import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CookieStore } from '../src/cookies.js';
import { WebApiShim } from '../src/shims/webapi.js';

/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let origin;
/** @type {{ method: string, url: string, headers: any, body: string }[]} */
let received;

beforeAll(async () => {
    received = [];
    server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            received.push({
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks).toString('utf8')
            });

            if (req.url === '/image') {
                res.writeHead(200, { 'Content-Type': 'image/webp' });
                res.end(Buffer.from([1, 2, 3]));
                return;
            }
            if (req.url === '/set-cookie') {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': 'auth=token123; Path=/; HttpOnly'
                });
                res.end('{"ok":true}');
                return;
            }
            if (req.url === '/redirect') {
                res.writeHead(302, { Location: '/echo' });
                res.end();
                return;
            }
            if (req.url === '/boom') {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"error":"nope"}');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

/**
 * @returns {WebApiShim}
 */
function createShim() {
    return new WebApiShim({
        cookies: new CookieStore(),
        userAgent: 'VRCX 2026.07.18'
    });
}

describe('WebApiShim', () => {
    it('returns a {Item1, Item2} tuple, not a Promise rejection', async () => {
        const result = await createShim().Execute({ url: `${origin}/echo` });
        expect(result).toEqual({ Item1: 200, Item2: '{"ok":true}' });
    });

    it('reports transport failures as Item1 === -1 with a string message', async () => {
        // src/services/webapi.js does `if (item.Item1 === -1) throw item.Item2`
        // and $throw only formats strings usefully.
        const result = await createShim().Execute({
            url: 'http://127.0.0.1:1/nothing-here'
        });
        expect(result.Item1).toBe(-1);
        expect(typeof result.Item2).toBe('string');
        expect(result.Item2.length).toBeGreaterThan(0);
    });

    it('passes HTTP error statuses through rather than treating them as failures', async () => {
        const result = await createShim().Execute({ url: `${origin}/boom` });
        expect(result).toEqual({ Item1: 500, Item2: '{"error":"nope"}' });
    });

    it('sends the VRCX user agent', async () => {
        await createShim().Execute({ url: `${origin}/echo` });
        expect(received.at(-1).headers['user-agent']).toBe('VRCX 2026.07.18');
    });

    it('puts Content-Type on the body and leaves other headers alone', async () => {
        await createShim().Execute({
            url: `${origin}/echo`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json;charset=utf-8',
                Authorization: 'Basic abc'
            },
            body: '{"a":1}'
        });

        const last = received.at(-1);
        expect(last.method).toBe('POST');
        expect(last.body).toBe('{"a":1}');
        expect(last.headers['content-type']).toBe(
            'application/json;charset=utf-8'
        );
        expect(last.headers.authorization).toBe('Basic abc');
    });

    it('does not send a body on GET', async () => {
        await createShim().Execute({
            url: `${origin}/echo`,
            method: 'GET',
            body: '{"a":1}'
        });
        expect(received.at(-1).body).toBe('');
    });

    it('returns binary responses as a data: URL with the image/png prefix', async () => {
        // Dotnet/WebApi.cs:468 hardcodes image/png regardless of the real type.
        const result = await createShim().Execute({ url: `${origin}/image` });
        expect(result.Item1).toBe(200);
        expect(result.Item2).toBe(
            `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`
        );
    });

    it('stores cookies from responses and replays them on the next request', async () => {
        const shim = createShim();
        await shim.Execute({ url: `${origin}/set-cookie` });
        await shim.Execute({ url: `${origin}/echo` });
        expect(received.at(-1).headers.cookie).toBe('auth=token123');
    });

    it('follows redirects and keeps cookies across the hop', async () => {
        const shim = createShim();
        await shim.Execute({ url: `${origin}/set-cookie` });
        const result = await shim.Execute({ url: `${origin}/redirect` });

        expect(result.Item1).toBe(200);
        expect(received.at(-1).url).toBe('/echo');
        expect(received.at(-1).headers.cookie).toBe('auth=token123');
    });

    it('refuses uploads loudly instead of sending a wrong body', async () => {
        const result = await createShim().Execute({
            url: `${origin}/echo`,
            uploadImage: true,
            imageData: 'AAAA'
        });
        expect(result.Item1).toBe(-1);
        expect(result.Item2).toMatch(/uploadImage is not supported/);
    });

    it('ExecuteJson mirrors the Electron-path shape', async () => {
        const json = await createShim().ExecuteJson(
            JSON.stringify({ url: `${origin}/echo` })
        );
        expect(JSON.parse(json)).toEqual({
            status: 200,
            message: '{"ok":true}'
        });
    });
});
