/**
 * The phase 3 HTTP/WS transport: TOTP auth → session cookie, the
 * generic `/api/rpc` dispatcher (`server/src/rpc.js`), and the `/api/stream`
 * pipeline fan-out (`server/src/pipeline-relay.js`). Raw `node:http` — three
 * routes plus one WS upgrade doesn't justify a framework — with the `ws`
 * package for the WebSocket *server* role specifically, since Node's
 * built-in `WebSocket` only covers the client role (already what the
 * pipeline connection itself uses).
 *
 * Phase 4 settled the previously-open "same-origin vs. separate deployment"
 * question in favour of same-origin: this file also serves the built web
 * client (`npm run prod-web`'s `build/html-web`) as static files, so the
 * browser only ever talks to its own origin and CORS never becomes a
 * question that needs an answer.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { WebSocketServer } from 'ws';

import { desktopAgent } from './agent.js';
import { groupInstanceRelay } from './group-instance-relay.js';
import {
    checkTotpCode,
    createSession,
    destroySession,
    hasServerTotp,
    readSessionToken,
    SESSION_COOKIE_NAME,
    setServerTotp,
    validateSession
} from './http-auth.js';
import { log } from './log.js';
import { pipelineRelay } from './pipeline-relay.js';
import { repoRoot } from './globals.js';
import { dispatchRpc } from './rpc.js';
import {
    generateTotpSecret,
    totpProvisioningUri,
    verifyTotpCode
} from './totp.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — generous for an RPC call, not for abuse

const WEB_CLIENT_DIR = path.join(repoRoot, 'build', 'html-web');

const CONTENT_TYPES = {
    '.html': 'text/html;charset=utf-8',
    '.js': 'text/javascript;charset=utf-8',
    '.css': 'text/css;charset=utf-8',
    '.json': 'application/json;charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
    '.map': 'application/json;charset=utf-8'
};

/**
 * Serves `npm run prod-web`'s output, with an SPA fallback to `index.html`
 * for any path that isn't a real file under `WEB_CLIENT_DIR` — client-side
 * routes like `/user/usr_...` have no matching file on disk, only the
 * bundle's own router (`src/plugins/router.js`, real and unaliased) knows
 * about them.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {boolean} whether this request was handled
 */
function serveWebClient(req, res) {
    if (!existsSync(WEB_CLIENT_DIR)) {
        return false;
    }
    const url = new URL(req.url, 'http://localhost');
    // path.resolve treats a leading '/' as "discard everything before it",
    // and `..` segments can walk back out past WEB_CLIENT_DIR either way —
    // neither join() nor resolve() is a sandbox by itself. The actual guard
    // is the prefix check below, against the *resolved* path.
    let filePath = path.resolve(WEB_CLIENT_DIR, `.${url.pathname}`);
    if (
        filePath !== WEB_CLIENT_DIR &&
        !filePath.startsWith(WEB_CLIENT_DIR + path.sep)
    ) {
        return false;
    }

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = path.join(WEB_CLIENT_DIR, 'index.html');
        if (!existsSync(filePath)) {
            return false;
        }
    }

    const contentType =
        CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    createReadStream(filePath).pipe(res);
    return true;
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>} parsed JSON body, or `{}` for an empty one
 */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        req.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error(`Invalid JSON body: ${err.message}`));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Found live: `database.getInstanceJoinHistory()` (and presumably other
 * `database.*` methods) returns a real `Map`, which `JSON.stringify`
 * silently serializes to `{}` (a Map has no own enumerable properties) —
 * the client then threw `TypeError: e is not iterable` trying to loop over
 * it. `[key, value]` array-of-entries is exactly what every observed
 * caller already loops over (`for (const [k, v] of data)` reads the same
 * off a Map or its `.entries()` array), so this is a lossless, generic fix
 * for every RPC response rather than special-casing one method.
 * @param {string} key
 * @param {any} value
 * @returns {any}
 */
function jsonReplacer(key, value) {
    if (value instanceof Map) {
        return Array.from(value.entries());
    }
    if (value instanceof Set) {
        return Array.from(value.values());
    }
    return value;
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {Record<string,string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body, jsonReplacer);
    res.writeHead(status, {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
    });
    res.end(payload);
}

/**
 * @param {string} token
 * @param {boolean} secure Adds `; Secure` when the listener is HTTPS — safe
 *   to always do in that case (there is no plain-HTTP endpoint on the same
 *   server for the cookie to still need to reach) and strictly better
 *   hygiene than leaving it off.
 * @returns {string}
 */
function sessionCookieHeader(token, secure) {
    return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}

/**
 * @param {boolean} secure
 * @returns {string}
 */
function expiredSessionCookieHeader(secure) {
    return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * Shared by `/api/login` and `/api/totp/confirm` — a freshly-confirmed TOTP
 * code is just as good as an existing session's code for starting a new
 * session, so enrollment doesn't need a separate "now log in again" step.
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {http.ServerResponse} res
 * @param {boolean} secure
 */
async function sendNewSession(handle, res, secure) {
    const token = await createSession(handle);
    // The raw token rides alongside the cookie so a non-browser client
    // (phase 5's desktop agent — not same-origin, can't rely on an
    // HttpOnly cookie) can pull it out of the JSON body and send it back as
    // `Authorization: Bearer <token>` instead. The browser client already
    // ignores response fields it doesn't know about.
    sendJson(
        res,
        200,
        { ok: true, token },
        { 'Set-Cookie': sessionCookieHeader(token, secure) }
    );
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {{ tls?: { cert: Buffer | string, key: Buffer | string } }} [options]
 *   `tls`, when given, must have both `cert` and `key` — the CLI's `serve`
 *   command is what reads the actual PEM files off disk
 *   (`VRCX_SERVER_TLS_CERT`/`VRCX_SERVER_TLS_KEY`, or `--tls-cert`/
 *   `--tls-key`) and validates that a partial pair is a config error, not
 *   something this function silently papers over.
 */
export async function createHttpServer(handle, options = {}) {
    // Unlike phase 3's original password-auth design, an unconfigured
    // server is allowed to start: /api/totp/setup and /api/totp/confirm
    // are exactly what let the browser itself complete first-run
    // enrollment, and neither route can do anything without a request
    // that either proves possession of the about-to-be-confirmed secret
    // or (per the one-shot refusal both routes already enforce) fails
    // outright once a secret exists. Every *other* route needs a valid
    // session, which is simply unreachable until enrollment finishes.
    if (!(await hasServerTotp(handle))) {
        log.warn(
            'No TOTP secret configured yet — open the web client to finish enrollment, or run `setup-totp` / set VRCX_SERVER_TOTP_SECRET.'
        );
    }

    const useHttps = Boolean(options.tls);
    const requestListener = (req, res) => {
        handleRequest(handle, req, res, useHttps).catch((err) => {
            log.error('HTTP request handler error', { message: err.message });
            if (!res.headersSent) {
                sendJson(res, 500, { ok: false, error: 'Internal error' });
            }
        });
    };
    const server = useHttps
        ? https.createServer(
              { cert: options.tls.cert, key: options.tls.key },
              requestListener
          )
        : http.createServer(requestListener);

    const wss = new WebSocketServer({ noServer: true });
    /** @type {Set<import('ws').WebSocket>} */
    const streamClients = new Set();

    pipelineRelay.on('frame', (data) => {
        for (const client of streamClients) {
            if (client.readyState === client.OPEN) {
                client.send(data);
            }
        }
    });

    // Shaped to look like a real pipeline frame (see group-instance-relay.js's
    // own header) so it rides the exact same connection/client set as the
    // frames above, rather than needing a second WebSocket.
    //
    // Cached and replayed to each newly-connecting client below: the real
    // poll this relays (src/stores/updateLoop.js) runs on a 5-minute cycle
    // starting the instant `serve` boots — well before the HTTP server even
    // starts listening — so without a replay, any client connecting after
    // that first tick (i.e. every real client) would see an empty Groups
    // sidebar for up to 5 minutes rather than the state the server already
    // has. Found live, not predicted: a fresh browser login landed with
    // `groupInstances.length === 0` despite the server's own poll having
    // already run.
    let lastGroupInstancesFrame = null;
    groupInstanceRelay.on('update', (payload) => {
        lastGroupInstancesFrame = JSON.stringify({
            type: 'vrcx-headless-group-instances',
            content: JSON.stringify(payload)
        });
        for (const client of streamClients) {
            if (client.readyState === client.OPEN) {
                client.send(lastGroupInstancesFrame);
            }
        }
    });

    server.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head).catch((err) => {
            log.error('WS upgrade handler error', { message: err.message });
            try {
                socket.destroy();
            } catch {
                // already closed/closing
            }
        });
    });

    /**
     * @param {http.IncomingMessage} req
     * @param {import('node:net').Socket} socket
     * @param {Buffer} head
     */
    async function handleUpgrade(req, socket, head) {
        const url = new URL(req.url, 'http://localhost');
        // src/services/websocket.js (unmodified) always builds its URL as
        // `${AppDebug.websocketDomain}/?auth=${token}` — an extra '/' the
        // client-web/bootstrap.js override can't avoid adding, since it
        // only controls websocketDomain, not the concatenation. So the
        // real request path is '/api/stream/', not '/api/stream'.
        const isStream =
            url.pathname === '/api/stream' || url.pathname === '/api/stream/';
        const isAgent = url.pathname === '/api/agent';
        if (!isStream && !isAgent) {
            socket.destroy();
            return;
        }
        // The desktop agent (phase 5) isn't same-origin, so it authenticates
        // with `Authorization: Bearer <token>` instead of the cookie the
        // browser client relies on — readSessionToken accepts either.
        if (!(await validateSession(handle, readSessionToken(req)))) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            if (isAgent) {
                desktopAgent.attach(ws);
                return;
            }
            streamClients.add(ws);
            ws.on('close', () => streamClients.delete(ws));
            if (lastGroupInstancesFrame !== null) {
                ws.send(lastGroupInstancesFrame);
            }
        });
    }

    return { server, streamClientCount: () => streamClients.size, useHttps };
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {boolean} secure
 */
async function handleRequest(handle, req, res, secure) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJsonBody(req);
        if (typeof body.code !== 'string' || !body.code) {
            sendJson(res, 400, { ok: false, error: 'code is required' });
            return;
        }
        if (!(await checkTotpCode(handle, body.code))) {
            sendJson(res, 401, { ok: false, error: 'Invalid code' });
            return;
        }
        await sendNewSession(handle, res, secure);
        return;
    }

    // Lets the client itself drive first-run TOTP enrollment (QR code +
    // confirm code, rather than requiring the setup-totp CLI command):
    // setup generates a secret without persisting it, confirm verifies a
    // code against it and only then saves it. Deliberately one-shot —
    // once a secret exists, both routes refuse unconditionally, with no
    // authenticated-rotation escape hatch. Rotating is `setup-totp`-only
    // (shell access to the box), so the browser never has an opportunity
    // to show the secret/QR again after the first successful enrollment.
    if (req.method === 'POST' && url.pathname === '/api/totp/setup') {
        if (await hasServerTotp(handle)) {
            sendJson(res, 403, {
                ok: false,
                error: 'Already configured — use the setup-totp CLI command to rotate'
            });
            return;
        }
        const secret = generateTotpSecret();
        sendJson(res, 200, {
            ok: true,
            secret,
            uri: totpProvisioningUri(secret, 'serve')
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/totp/confirm') {
        if (await hasServerTotp(handle)) {
            sendJson(res, 403, {
                ok: false,
                error: 'Already configured — use the setup-totp CLI command to rotate'
            });
            return;
        }
        const body = await readJsonBody(req);
        if (typeof body.secret !== 'string' || !body.secret) {
            sendJson(res, 400, { ok: false, error: 'secret is required' });
            return;
        }
        if (!verifyTotpCode(body.secret, body.code)) {
            sendJson(res, 400, { ok: false, error: 'Invalid code' });
            return;
        }
        await setServerTotp(handle, body.secret);
        await sendNewSession(handle, res, secure);
        return;
    }

    // Rotates a still-valid session into a fresh one with a full new
    // `SESSION_TTL_MS` expiry (`server/src/http-auth.js`) — both clients
    // call this on every launch instead of a read-only validity probe, so
    // "reopen within the window" slides the window forward indefinitely
    // rather than counting down from the original login. The old token is
    // revoked immediately (`destroySession`) so a launch doesn't leave a
    // trail of still-valid tokens behind it.
    if (req.method === 'POST' && url.pathname === '/api/session/refresh') {
        const existingToken = readSessionToken(req);
        if (!(await validateSession(handle, existingToken))) {
            sendJson(res, 401, { ok: false, error: 'Not authenticated' });
            return;
        }
        await destroySession(handle, existingToken);
        await sendNewSession(handle, res, secure);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
        await destroySession(handle, readSessionToken(req));
        sendJson(
            res,
            200,
            { ok: true },
            { 'Set-Cookie': expiredSessionCookieHeader(secure) }
        );
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc') {
        if (!(await validateSession(handle, readSessionToken(req)))) {
            sendJson(res, 401, { ok: false, error: 'Not authenticated' });
            return;
        }
        const body = await readJsonBody(req);
        const result = await dispatchRpc(handle, body);
        sendJson(res, 200, result);
        return;
    }

    // Everything under /api/* is handled above; anything else is a request
    // for the built web client (or a 404 if it was never built — `serve`
    // still works API-only, e.g. a container that only needs the RPC/stream
    // surface, no bundled client).
    if (
        req.method === 'GET' &&
        !url.pathname.startsWith('/api/') &&
        serveWebClient(req, res)
    ) {
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}
