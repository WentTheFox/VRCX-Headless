/**
 * The server's i18n must translate, not echo keys: `src/services/request.js`
 * builds API error toasts from `i18n.global.t` directly, and Discord presence
 * text is composed server-side.
 */
import { describe, expect, it } from 'vitest';

import { i18n } from '../src/shims/i18n.js';

describe('i18n shim', () => {
    it('resolves English messages instead of echoing the key', () => {
        expect(i18n.global.t('api.error.message.error_message')).toBe('Error Message');
        expect(i18n.global.t('api.error.message.endpoint')).toBe('Endpoint');
    });

    it('still returns the key for a genuinely missing message', () => {
        expect(i18n.global.t('no.such.key')).toBe('no.such.key');
    });
});
