/**
 * `server/src/shims/modal.js`'s `otpPrompt` — specifically the
 * `VRCHAT_2FA_SECRET` env-var path that lets an unattended auto-login retry
 * clear a TOTP challenge without a human at stdin.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { generateTotpCode, generateTotpSecret } from '../src/totp.js';
import { useModalStore } from '../src/shims/modal.js';

const ENV_KEYS = ['VRCHAT_2FA_CODE', 'VRCHAT_2FA_SECRET'];

function clearEnv() {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
}

describe('modal.otpPrompt', () => {
    afterEach(clearEnv);

    it('generates a fresh TOTP code from VRCHAT_2FA_SECRET for mode: totp', async () => {
        clearEnv();
        const secret = generateTotpSecret();
        process.env.VRCHAT_2FA_SECRET = secret;
        const result = await useModalStore().otpPrompt({ mode: 'totp' });
        expect(result).toEqual({
            ok: true,
            reason: 'ok',
            value: generateTotpCode(secret)
        });
    });

    it('VRCHAT_2FA_CODE still takes priority over VRCHAT_2FA_SECRET', async () => {
        clearEnv();
        process.env.VRCHAT_2FA_CODE = '123456';
        process.env.VRCHAT_2FA_SECRET = generateTotpSecret();
        const result = await useModalStore().otpPrompt({ mode: 'totp' });
        expect(result).toEqual({ ok: true, reason: 'ok', value: '123456' });
    });

    it('does not use VRCHAT_2FA_SECRET for non-totp modes (falls through to stdin)', async () => {
        clearEnv();
        process.env.VRCHAT_2FA_SECRET = generateTotpSecret();
        const result = await Promise.race([
            useModalStore().otpPrompt({ mode: 'otp' }),
            new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50))
        ]);
        expect(result).toBe('timed-out');
    });

    it('accepts a lowercase secret grouped in 4s with spaces (common authenticator-export formatting)', async () => {
        clearEnv();
        const secret = generateTotpSecret();
        const grouped = secret
            .toLowerCase()
            .match(/.{1,4}/g)
            .join(' ');
        process.env.VRCHAT_2FA_SECRET = grouped;
        const result = await useModalStore().otpPrompt({ mode: 'totp' });
        expect(result).toEqual({
            ok: true,
            reason: 'ok',
            value: generateTotpCode(secret)
        });
    });

    it('falls back to stdin (rather than a silently-wrong code) when the secret has non-base32 characters', async () => {
        clearEnv();
        // 0/1/8/9 are never valid base32 -- deliberately excluded from the
        // alphabet to avoid confusion with O/I(l)/B/g.
        process.env.VRCHAT_2FA_SECRET = 'abcd018 9efgh';
        const result = await Promise.race([
            useModalStore().otpPrompt({ mode: 'totp' }),
            new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50))
        ]);
        expect(result).toBe('timed-out');
    });
});
