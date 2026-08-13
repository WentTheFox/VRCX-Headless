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
 */
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
        }
    };
}
