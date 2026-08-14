/**
 * RFC 6238 TOTP (built on RFC 4226's HOTP) — `node:crypto` only, no
 * dependency, same "boring on purpose" philosophy as `http-auth.js`'s own
 * scrypt-based password hashing used to be. Replaces the static password
 * `serve` used to require: a rotating 6-digit code from a standard 2FA app
 * (Bitwarden, Google Authenticator, 1Password, Authy, …) instead. The win
 * is specifically against passive capture — the common deployment is a
 * home-network Docker container over plain HTTP (`server/README.md`'s own
 * security notes) — a sniffed code is worthless outside its 30s window,
 * unlike a sniffed static password. The shared secret itself is still the
 * one long-lived credential (same threat model as a password hash), so
 * `VRCX.sqlite3` remains something to treat as a secret regardless.
 */
import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_BYTES = 20; // 160 bits — RFC 4226's recommended HMAC-SHA1 key size
const STEP_SECONDS = 30;
const DIGITS = 6;
// Tolerates +/-30s of clock skew between this machine and the one that
// generated the code — standard TOTP verification practice, not a security
// hole: it only ever widens the 30s window to 90s, never removes it.
const VERIFY_WINDOW_STEPS = 1;

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
export function base32Encode(bytes) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }
    return output;
}

/**
 * @param {string} encoded
 * @returns {Buffer}
 */
export function base32Decode(encoded) {
    const clean = String(encoded)
        .toUpperCase()
        .replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) {
            continue;
        }
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

/**
 * @returns {string} a new random base32-encoded secret
 */
export function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/**
 * RFC 4226 HOTP with dynamic truncation.
 * @param {Buffer} secretBytes
 * @param {number} counter
 * @returns {string} zero-padded `DIGITS`-length code
 */
function hotp(secretBytes, counter) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto
        .createHmac('sha1', secretBytes)
        .update(counterBuffer)
        .digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/**
 * @param {string} base32Secret
 * @param {number} [at] unix ms — defaults to `Date.now()`, parameterized so
 *   tests can pin it against RFC 6238's own published test vectors
 * @returns {string}
 */
export function generateTotpCode(base32Secret, at = Date.now()) {
    const counter = Math.floor(at / 1000 / STEP_SECONDS);
    return hotp(base32Decode(base32Secret), counter);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        // Both operands to timingSafeEqual must be equal length; a and b
        // are always DIGITS-length by the caller's own regex check before
        // this is reached, so this branch is defensive, not a real path.
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * @param {string} base32Secret
 * @param {unknown} code
 * @param {number} [at]
 * @returns {boolean}
 */
export function verifyTotpCode(base32Secret, code, at = Date.now()) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        return false;
    }
    const secretBytes = base32Decode(base32Secret);
    const counter = Math.floor(at / 1000 / STEP_SECONDS);
    for (
        let delta = -VERIFY_WINDOW_STEPS;
        delta <= VERIFY_WINDOW_STEPS;
        delta++
    ) {
        if (timingSafeStringEqual(hotp(secretBytes, counter + delta), code)) {
            return true;
        }
    }
    return false;
}

/**
 * A standard `otpauth://` provisioning URI (the informal "Key URI Format"
 * every mainstream TOTP app, including Bitwarden, accepts for manual
 * import/paste) — `setup-totp` prints this alongside the raw secret.
 * @param {string} base32Secret
 * @param {string} label
 * @param {string} [issuer]
 * @returns {string}
 */
export function totpProvisioningUri(base32Secret, label, issuer = 'VRCX') {
    const params = new URLSearchParams({
        secret: base32Secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS)
    });
    return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
}
