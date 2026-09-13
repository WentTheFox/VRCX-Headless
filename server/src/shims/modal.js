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
 * checks for the password). For `mode: 'totp'` specifically, `VRCHAT_2FA_SECRET`
 * (a base32 secret from the *VRChat* account's own authenticator enrollment —
 * distinct from `VRCX_SERVER_TOTP_SECRET`, which protects this server's own
 * HTTP API) generates a fresh code on every call instead. `VRCHAT_2FA_CODE`
 * is a single code, stale after one use — fine for a one-shot `login` CLI
 * run, but useless for the unattended re-logins `authAutoLoginCoordinator.js`
 * triggers over a server's lifetime, which is exactly when there's no human
 * around to supply a fresh one. `mode: 'otp'` (backup code) and `'emailOtp'`
 * have no equivalent — a backup code is single-use by design and an email
 * code can't be derived locally — so those still fall through to stdin.
 */
import { ask } from '../prompt.js';
import { log } from '../log.js';
import { generateTotpCode } from '../totp.js';

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

// Real base32 (RFC 4648) never contains 0/1/8/9 -- they're deliberately
// excluded from the alphabet to avoid confusion with O/I(l)/B/g. totp.js's
// own base32Decode() silently *drops* anything outside A-Z2-7 rather than
// erroring (so setup-totp's own manual-entry parsing tolerates stray
// whitespace/dashes), which is exactly wrong for a secret pasted from
// somewhere else -- it would quietly decode to a shorter, wrong key and
// every generated code would just fail forever with nothing in the logs to
// explain why. Checked here, at the one call site that takes an
// externally-supplied secret on faith, rather than loosening
// base32Decode's own tolerant behaviour everywhere else it's used.
const BASE32_SHAPE = /^[A-Za-z2-7]+$/;

/**
 * @param {string} rawSecret
 * @returns {string | null} the normalized secret, or `null` if it isn't
 *   plausibly base32
 */
function normalizeBase32Secret(rawSecret) {
    const stripped = rawSecret.replace(/[\s-]/g, '');
    return BASE32_SHAPE.test(stripped) ? stripped : null;
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
            let value = process.env.VRCHAT_2FA_CODE;
            if (value === undefined && options?.mode === 'totp' && process.env.VRCHAT_2FA_SECRET) {
                const secret = normalizeBase32Secret(process.env.VRCHAT_2FA_SECRET);
                if (secret) {
                    value = generateTotpCode(secret);
                } else {
                    log.error(
                        'VRCHAT_2FA_SECRET is not valid base32 (only A-Z and 2-7 -- never 0/1/8/9) -- falling back to stdin'
                    );
                }
            }
            value ??= await ask(label);
            return { ok: !!value, reason: value ? 'ok' : 'cancel', value };
        }
    };
}
