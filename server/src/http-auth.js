/**
 * Password auth and session tokens for the phase 3 HTTP/WS transport
 * (`server/src/http-server.js`). Nothing here is VRChat-specific — this
 * protects the server's own `/api/*` routes, a separate concern from
 * `server/src/session.js` (the VRChat account session).
 *
 * ## Password source
 *
 * Checked in this order, mirroring the existing `VRCHAT_PASSWORD` env-var
 * convention already used for non-interactive VRChat login
 * (`server/src/cli.js`):
 *
 * 1. `VRCX_SERVER_PASSWORD` env var — compared directly (timing-safe), for
 *    non-interactive/Docker setup. Never hashed or stored; it is already a
 *    secret the deployment controls.
 * 2. A hash stored via `configRepository.setString('VRCX_ServerPasswordHash', …)`,
 *    set through the `set-password` CLI command.
 * 3. Neither set — `requirePassword` throws, and `server/src/cli.js`'s
 *    `serve` command refuses to start rather than open an unauthenticated
 *    listener.
 *
 * ## Sessions
 *
 * Tokens are `crypto.randomBytes(32)`, kept in an in-memory `Map` —
 * process-lifetime only for this first slice. Restarting the server signs
 * everyone out; there is no persistence or rotation yet. That is a
 * deliberate scope cut, not an oversight: phase 3's job is proving the
 * transport works at all.
 */
import crypto from 'node:crypto';

const CONFIG_KEY = 'VRCX_ServerPasswordHash';
const SCRYPT_KEY_LENGTH = 64;

/** @type {Map<string, { createdAt: number }>} */
const sessions = new Map();

/**
 * @param {string} password
 * @returns {string} `${saltHex}:${hashHex}`
 */
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto
        .scryptSync(password, salt, SCRYPT_KEY_LENGTH)
        .toString('hex');
    return `${salt}:${hash}`;
}

/**
 * @param {string} password
 * @param {string} stored `${saltHex}:${hashHex}`, from `hashPassword`
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
    const [salt, hashHex] = String(stored).split(':');
    if (!salt || !hashHex) {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
    return (
        expected.length === actual.length &&
        crypto.timingSafeEqual(expected, actual)
    );
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    // Buffers of different length would make timingSafeEqual throw, and
    // comparing against a length-matched buffer of zeros first keeps the
    // rejection itself constant-time rather than leaking length by throwing
    // early only for wrong-length input.
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<string | null>} the stored hash, or `null` if unset
 */
async function getStoredHash(handle) {
    const value = await handle.configRepository.getString(CONFIG_KEY, '');
    return value || null;
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {string} password
 */
export async function setServerPassword(handle, password) {
    await handle.configRepository.setString(CONFIG_KEY, hashPassword(password));
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @returns {Promise<boolean>} whether a password is configured (env var or stored hash)
 */
export async function hasServerPassword(handle) {
    if (process.env.VRCX_SERVER_PASSWORD) {
        return true;
    }
    return (await getStoredHash(handle)) !== null;
}

/**
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function checkPassword(handle, password) {
    const envPassword = process.env.VRCX_SERVER_PASSWORD;
    if (envPassword) {
        return timingSafeStringEqual(password, envPassword);
    }
    const stored = await getStoredHash(handle);
    if (!stored) {
        return false;
    }
    return verifyPassword(password, stored);
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
