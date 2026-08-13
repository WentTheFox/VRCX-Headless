/**
 * Headless stand-in for `src/stores/modal.js`.
 *
 * The real store's `confirm`/`alert`/`prompt` return promises that resolve
 * when a human clicks a button in a dialog that only exists in a mounted Vue
 * app — headless, they would simply hang forever. It also calls `useI18n()`
 * at store-setup scope, which needs a real injected i18n instance (phase 2b
 * step 5) to not throw. Stays stubbed permanently — same reasoning as `ui.js`
 * (`server/src/shims/ui.js`): a headless process has no dialogs.
 *
 * `src/services/sqlite.js`, `src/services/request.js` and three coordinators
 * reach this for `alert`/`prompt` (grepped, not guessed); `confirm` is kept
 * for parity even though nothing in the current closure calls it.
 *
 * `otpPrompt` is the one exception to "always declined, there is no user":
 * `src/stores/auth.js`'s `promptTOTP`/`promptOTP`/`promptEmailOTP` are the
 * *real* 2FA flow (phase 2b step 7), and unlike a confirm dialog there is no
 * safe non-interactive default — a 2FA code has to come from somewhere, so
 * this reads one from stdin via the same `ask()` the CLI's own prompts use.
 * An empty answer resolves `reason: 'cancel'`, which upstream's own code
 * treats as "try the other 2FA method" (TOTP ↔ backup code) — reasonable
 * behaviour to inherit for free rather than something built for here.
 * `VRCHAT_2FA_CODE` takes priority when set, for non-interactive login
 * (`server/README.md`'s documented env var, same one `server/src/cli.js`
 * checks for the password).
 */
import { ask } from '../prompt.js';
import { log } from '../log.js';

/**
 * @param {string} kind
 * @param {{ title?: string, description?: string }} options
 */
function record(kind, options) {
    log.warn(`modal.${kind}`, {
        title: options?.title,
        description: options?.description
    });
}

export function useModalStore() {
    return {
        /**
         * @param {{ title?: string, description?: string }} options
         * @returns {Promise<{ ok: boolean }>} always declined — there is no user
         */
        confirm(options) {
            record('confirm', options);
            return Promise.resolve({ ok: false });
        },
        /**
         * @param {{ title?: string, description?: string }} options
         */
        alert(options) {
            record('alert', options);
            return Promise.resolve({ ok: true });
        },
        prompt(options) {
            record('prompt', options);
            return Promise.resolve({ ok: false, value: '' });
        },
        /**
         * @param {{ title?: string, description?: string }} options
         * @returns {Promise<{ ok: boolean, reason: 'ok' | 'cancel', value: string }>}
         */
        async otpPrompt(options) {
            const label = options?.title ? `${options.title}: ` : '2FA code: ';
            const value = process.env.VRCHAT_2FA_CODE ?? (await ask(label));
            return { ok: !!value, reason: value ? 'ok' : 'cancel', value };
        }
    };
}
