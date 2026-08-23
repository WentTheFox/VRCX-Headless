/**
 * TOTP auth and session tokens for the phase 3 HTTP/WS transport
 * (`server/src/http-server.js`). Nothing here is VRChat-specific — this
 * protects the server's own `/api/*` routes, a separate concern from
 * `server/src/session.js` (the VRChat account session).
 *
 * Originally a static password (scrypt-hashed); replaced with a rotating
 * 6-digit TOTP code (`./totp.js`, RFC 6238) at the user's request, mid-phase-5
 * session — a sniffed *code* is worthless outside its 30s window, unlike a
 * sniffed static password, which matters given the common deployment is a
 * home-network Docker container over plain HTTP (`server/README.md`'s own
 * security notes). The *secret* is still the one long-lived credential
 * (same threat model a password hash had), so `VRCX.sqlite3` remains
 * something to treat as a secret either way.
 *
 * ## Secret source
 *
 * Checked in this order, mirroring the existing `VRCHAT_PASSWORD` env-var
 * convention already used for non-interactive VRChat login
 * (`server/src/cli.js`):
 *
 * 1. `VRCX_SERVER_TOTP_SECRET` env var — a base32 secret, for
 *    non-interactive/Docker setup. Used directly; never re-stored.
 * 2. A secret stored via `configRepository.setString('VRCX_ServerTotpSecret', …)`,
 *    set through the `setup-totp` CLI command (which also confirms the user
 *    actually enrolled it in a real app before persisting it).
 * 3. Neither set — `serve` refuses to start rather than open an
 *    unauthenticated listener.
 *
 * ## Sessions
 *
 * Signed, self-verifying tokens (HS256, same three-part `header.payload.
 * signature` shape as a JWT — hand-rolled with `node:crypto` only, same
 * "boring on purpose" philosophy as `./totp.js`) rather than opaque tokens
 * in an in-memory `Map`. The original in-memory design signed everyone out
 * on every `serve` restart, which defeated the desktop client's own
 * already-persisted `VRCX_ServerToken` (`src-electron/main.js`) — a crash,
 * update, or routine redeploy meant re-entering the TOTP code every time,
 * even though the client still had a perfectly good token. Verifying the
 * signature statelessly against a secret persisted in `VRCX.sqlite3`
 * (`configRepository`, same storage `./totp.js`'s own secret uses) means a
 * token stays valid across restarts without the server remembering
 * anything about the request that issued it — exactly the property needed
 * for "bypass 2FA on launch" to actually hold. Long-lived by design
 * (`SESSION_TTL_MS`, 180 days): the TOTP code already gates *getting* a
 * token in the first place, so the token itself doesn't need a short
 * expiry to carry security weight.
 *
 * Logout revocation is best-effort, deliberately: a destroyed token's
 * `jti` is added to an in-memory denylist, so it stops working immediately
 * within the running process, but a `serve` restart forgets the denylist
 * (the same tradeoff `./totp.js`'s own secret rotation already accepts —
 * shell access to rotate `VRCX_ServerTotpSecret` is the actual trust
 * boundary). No client currently calls `/api/logout`, so this only matters
 * if one starts to.
 */
import crypto from 'node:crypto';

import { verifyTotpCode } from './totp.js';

const TOTP_CONFIG_KEY = 'VRCX_ServerTotpSecret';
const SESSION_SECRET_CONFIG_KEY = 'VRCX_ServerSessionSecret';
// Exported so http-server.js's session cookie's Max-Age can match this
// exactly — see that file's sessionCookieHeader() for why that matters.
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/**
 * Cached per database handle so `validateSession` — called on every
 * `/api/rpc` request and WS upgrade — doesn't hit `configRepository` each
 * time. Populated once, lazily, the first time a session is created or
 * checked against a given handle.
 * @type {WeakMap<import('./db.js').DatabaseHandle, Promise<string>>}
 */
const sessionSecretCache = new WeakMap();

/** @type {Set<string>} revoked `jti`s — see the "Logout revocation" doc above */
const revokedTokenIds = new Set();

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<string | null>} the stored secret, or `null` if unset
 */
async function getStoredTotpSecret(handle) {
    const value = await handle.configRepository.getString(TOTP_CONFIG_KEY, '');
    return value || null;
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {string} secret base32, from `./totp.js`'s `generateTotpSecret()`
 */
export async function setServerTotp(handle, secret) {
    await handle.configRepository.setString(TOTP_CONFIG_KEY, secret);
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<boolean>} whether a TOTP secret is configured (env var or stored)
 */
export async function hasServerTotp(handle) {
    if (process.env.VRCX_SERVER_TOTP_SECRET) {
        return true;
    }
    return (await getStoredTotpSecret(handle)) !== null;
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {string} code the 6-digit code from the user's authenticator app
 * @returns {Promise<boolean>}
 */
export async function checkTotpCode(handle, code) {
    const secret =
        process.env.VRCX_SERVER_TOTP_SECRET ||
        (await getStoredTotpSecret(handle));
    if (!secret) {
        return false;
    }
    return verifyTotpCode(secret, code);
}

/**
 * The HMAC key session tokens are signed with, persisted so it (and
 * therefore every token signed with it) survives a `serve` restart.
 * Generated once, on first use — unlike the TOTP secret, this one is never
 * shown to a user, so there's no enrollment step to gate it behind.
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<string>}
 */
function getSessionSecret(handle) {
    let cached = sessionSecretCache.get(handle);
    if (!cached) {
        cached = (async () => {
            const stored = await handle.configRepository.getString(
                SESSION_SECRET_CONFIG_KEY,
                ''
            );
            if (stored) {
                return stored;
            }
            const generated = crypto.randomBytes(32).toString('hex');
            await handle.configRepository.setString(
                SESSION_SECRET_CONFIG_KEY,
                generated
            );
            return generated;
        })();
        sessionSecretCache.set(handle, cached);
    }
    return cached;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function base64url(value) {
    const buffer = typeof value === 'string' ? Buffer.from(value) : value;
    return buffer.toString('base64url');
}

const JWT_HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

/**
 * @param {{ iat: number, exp: number, jti: string }} payload
 * @param {string} secret
 * @returns {string}
 */
function signToken(payload, secret) {
    const body = base64url(JSON.stringify(payload));
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${JWT_HEADER}.${body}`)
        .digest('base64url');
    return `${JWT_HEADER}.${body}.${signature}`;
}

/**
 * @param {string} token
 * @param {string} secret
 * @returns {{ iat: number, exp: number, jti: string } | null} the decoded
 *   payload, or `null` if the token is malformed, unsigned by this secret,
 *   or expired
 */
function verifyToken(token, secret) {
    if (typeof token !== 'string') {
        return null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }
    const [header, body, signature] = parts;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${header}.${body}`)
        .digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
        signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
        return null;
    }
    /** @type {{ iat: number, exp: number, jti: string }} */
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
        return null;
    }
    return payload;
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<string>} the new session token
 */
export async function createSession(handle) {
    const secret = await getSessionSecret(handle);
    const now = Date.now();
    return signToken(
        {
            iat: now,
            exp: now + SESSION_TTL_MS,
            jti: crypto.randomBytes(16).toString('hex')
        },
        secret
    );
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {string | undefined} token
 * @returns {Promise<boolean>}
 */
export async function validateSession(handle, token) {
    if (!token) {
        return false;
    }
    const secret = await getSessionSecret(handle);
    const payload = verifyToken(token, secret);
    return !!payload && !revokedTokenIds.has(payload.jti);
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {string | undefined} token
 */
export async function destroySession(handle, token) {
    if (!token) {
        return;
    }
    const secret = await getSessionSecret(handle);
    const payload = verifyToken(token, secret);
    if (payload) {
        revokedTokenIds.add(payload.jti);
    }
}

export const SESSION_COOKIE_NAME = 'vrcx_session';

/**
 * @param {string | undefined} cookieHeader
 * @returns {string | undefined}
 */
export function readSessionCookie(cookieHeader) {
    if (!cookieHeader) {
        return undefined;
    }
    for (const part of cookieHeader.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === SESSION_COOKIE_NAME) {
            return rest.join('=');
        }
    }
    return undefined;
}

/**
 * Phase 5's desktop agent isn't same-origin, so it can't rely on the
 * `HttpOnly` cookie the way the browser client does — it authenticates with
 * `Authorization: Bearer <token>` instead, using the same token
 * `/api/login`'s JSON response now also returns alongside the `Set-Cookie`
 * header. Checked first since it's the cheaper parse; falls back to the
 * cookie so nothing about the existing browser-client flow changes.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | undefined}
 */
export function readSessionToken(req) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice('Bearer '.length);
    }
    return readSessionCookie(req.headers.cookie);
}
