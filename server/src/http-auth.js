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
 * Tokens are `crypto.randomBytes(32)`, kept in an in-memory `Map` —
 * process-lifetime only for this first slice. Restarting the server signs
 * everyone out; there is no persistence or rotation yet. That is a
 * deliberate scope cut, not an oversight: phase 3's job was proving the
 * transport works at all, and nothing since has needed to revisit it.
 */
import crypto from 'node:crypto';

import { verifyTotpCode } from './totp.js';

const TOTP_CONFIG_KEY = 'VRCX_ServerTotpSecret';

/** @type {Map<string, { createdAt: number }>} */
const sessions = new Map();

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<string | null>} the stored secret, or `null` if unset
 */
async function getStoredTotpSecret(handle) {
    const value = await handle.configRepository.getString(
        TOTP_CONFIG_KEY,
        ''
    );
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
        process.env.VRCX_SERVER_TOTP_SECRET || (await getStoredTotpSecret(handle));
    if (!secret) {
        return false;
    }
    return verifyTotpCode(secret, code);
}

/**
 * @returns {string} the new session token
 */
export function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now() });
    return token;
}

/**
 * @param {string | undefined} token
 * @returns {boolean}
 */
export function validateSession(token) {
    return !!token && sessions.has(token);
}

/**
 * @param {string | undefined} token
 */
export function destroySession(token) {
    if (token) {
        sessions.delete(token);
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
