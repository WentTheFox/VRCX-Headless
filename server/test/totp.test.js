/**
 * `server/src/totp.js` against RFC 6238's own published SHA1 test vectors
 * (Appendix B) — the strongest possible confidence check for a from-scratch
 * HOTP/TOTP implementation, not just internal self-consistency.
 */
import { describe, expect, it } from 'vitest';

import {
    base32Decode,
    base32Encode,
    generateTotpCode,
    generateTotpSecret,
    totpProvisioningUri,
    verifyTotpCode
} from '../src/totp.js';

describe('base32Encode / base32Decode', () => {
    it('round-trips arbitrary bytes', () => {
        const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 16, 32, 64]);
        expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    });

    it('matches the RFC 4648 test vector for "foobar"', () => {
        // https://www.rfc-editor.org/rfc/rfc4648#section-10
        expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI======'.replace(/=+$/, ''));
    });

    it('decode ignores separators and lowercase', () => {
        const bytes = Buffer.from('hello world');
        const encoded = base32Encode(bytes);
        const messy = encoded.toLowerCase().split('').join('-');
        expect(base32Decode(messy)).toEqual(bytes);
    });
});

describe('generateTotpCode against RFC 6238 Appendix B (SHA1)', () => {
    // The RFC's own test key is the raw ASCII bytes "12345678901234567890",
    // not base32 -- base32-encoding it ourselves is exactly what
    // generateTotpSecret's real callers do to a random secret, so this
    // exercises the same path a real secret takes.
    const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

    // RFC 6238 Appendix B lists 8-digit OTPs; this implementation truncates
    // to 6 (Google-Authenticator-compatible), which is just the low 6
    // digits of the same value (mod 10^6 instead of mod 10^8) -- same
    // dynamic-truncation binary value underneath.
    it.each([
        [59, '287082'],
        [1111111109, '081804'],
        [1111111111, '050471'],
        [1234567890, '005924'],
        [2000000000, '279037']
    ])('T=%i -> %s', (unixSeconds, expected) => {
        expect(generateTotpCode(secret, unixSeconds * 1000)).toBe(expected);
    });
});

describe('verifyTotpCode', () => {
    const secret = generateTotpSecret();
    const now = Date.parse('2026-01-01T00:00:00Z');

    it('accepts the current code', () => {
        const code = generateTotpCode(secret, now);
        expect(verifyTotpCode(secret, code, now)).toBe(true);
    });

    it('accepts a code from one step in the past or future (clock skew)', () => {
        const stepMs = 30_000;
        const past = generateTotpCode(secret, now - stepMs);
        const future = generateTotpCode(secret, now + stepMs);
        expect(verifyTotpCode(secret, past, now)).toBe(true);
        expect(verifyTotpCode(secret, future, now)).toBe(true);
    });

    it('rejects a code more than one step away', () => {
        const farPast = generateTotpCode(secret, now - 3 * 30_000);
        expect(verifyTotpCode(secret, farPast, now)).toBe(false);
    });

    it('rejects a code from a different secret', () => {
        const otherSecret = generateTotpSecret();
        const code = generateTotpCode(otherSecret, now);
        expect(verifyTotpCode(secret, code, now)).toBe(false);
    });

    it('rejects malformed input instead of throwing', () => {
        expect(verifyTotpCode(secret, '', now)).toBe(false);
        expect(verifyTotpCode(secret, 'abcdef', now)).toBe(false);
        expect(verifyTotpCode(secret, '12345', now)).toBe(false);
        expect(verifyTotpCode(secret, undefined, now)).toBe(false);
        expect(verifyTotpCode(secret, null, now)).toBe(false);
        expect(verifyTotpCode(secret, 123456, now)).toBe(false);
    });
});

describe('generateTotpSecret', () => {
    it('generates a plausible-length base32 secret, different each time', () => {
        const a = generateTotpSecret();
        const b = generateTotpSecret();
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[A-Z2-7]+$/);
        expect(a.length).toBeGreaterThanOrEqual(32);
    });
});

describe('totpProvisioningUri', () => {
    it('produces a well-formed otpauth:// URI carrying the secret', () => {
        const uri = totpProvisioningUri('JBSWY3DPEHPK3PXP', 'serve');
        expect(uri.startsWith('otpauth://totp/')).toBe(true);
        const parsed = new URL(uri);
        expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
        expect(parsed.searchParams.get('digits')).toBe('6');
        expect(parsed.searchParams.get('period')).toBe('30');
    });
});
