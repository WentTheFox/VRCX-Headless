/**
 * The phase 3 HTTP/WS transport: password auth → session cookie, the
 * generic `/api/rpc` dispatcher (`server/src/rpc.js`), and the `/api/stream`
 * pipeline fan-out (`server/src/pipeline-relay.js`). Raw `node:http` — three
 * routes plus one WS upgrade doesn't justify a framework — with the `ws`
 * package for the WebSocket *server* role specifically, since Node's
 * built-in `WebSocket` only covers the client role (already what the
 * pipeline connection itself uses).
 *
 * No CORS handling yet: phase 4's web client shape (same-origin vs. a
 * separate dev server) isn't decided, so there is nothing concrete to
 * configure against. Add it when that decision exists instead of guessing.
 */
import http from 'node:http';

import { WebSocketServer } from 'ws';

import {
    checkPassword,
    createSession,
    destroySession,
    hasServerPassword,
    readSessionCookie,
    SESSION_COOKIE_NAME,
    validateSession
} from './http-auth.js';
import { log } from './log.js';
import { pipelineRelay } from './pipeline-relay.js';
import { dispatchRpc } from './rpc.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — generous for an RPC call, not for abuse

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
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {any} body
 * @param {Record<string,string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
    });
    res.end(payload);
}

/**
 * @param {string} token
 * @returns {string}
 */
function sessionCookieHeader(token) {
    return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

const EXPIRED_SESSION_COOKIE_HEADER = `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/**
 * @param {import('./db.js').DatabaseHandle} handle
 */
export async function createHttpServer(handle) {
    if (!(await hasServerPassword(handle))) {
        throw new Error(
            'No server password configured. Run `set-password`, or set VRCX_SERVER_PASSWORD.'
        );
    }

    const server = http.createServer((req, res) => {
        handleRequest(handle, req, res).catch((err) => {
            log.error('HTTP request handler error', { message: err.message });
            if (!res.headersSent) {
                sendJson(res, 500, { ok: false, error: 'Internal error' });
            }
        });
    });

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

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/api/stream') {
            socket.destroy();
            return;
        }
        const token = readSessionCookie(req.headers.cookie);
        if (!validateSession(token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            streamClients.add(ws);
            ws.on('close', () => streamClients.delete(ws));
        });
    });

    return { server, streamClientCount: () => streamClients.size };
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleRequest(handle, req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJsonBody(req);
        if (typeof body.password !== 'string' || !body.password) {
            sendJson(res, 400, { ok: false, error: 'password is required' });
            return;
        }
        if (!(await checkPassword(handle, body.password))) {
            sendJson(res, 401, { ok: false, error: 'Invalid password' });
            return;
        }
        const token = createSession();
        sendJson(
            res,
            200,
            { ok: true },
            { 'Set-Cookie': sessionCookieHeader(token) }
        );
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
        destroySession(readSessionCookie(req.headers.cookie));
        sendJson(
            res,
            200,
            { ok: true },
            { 'Set-Cookie': EXPIRED_SESSION_COOKIE_HEADER }
        );
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc') {
        if (!validateSession(readSessionCookie(req.headers.cookie))) {
            sendJson(res, 401, { ok: false, error: 'Not authenticated' });
            return;
        }
        const body = await readJsonBody(req);
        const result = await dispatchRpc(handle, body);
        sendJson(res, 200, result);
        return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
}
