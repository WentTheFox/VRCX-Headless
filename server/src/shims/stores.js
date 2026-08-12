/**
 * Headless stand-in for `src/stores/index.js`.
 *
 * Aliased in because `src/services/sqlite.js` imports `useModalStore` to turn
 * SQLite failures into modal dialogs. Importing the real barrel would pull all
 * 36 Pinia stores (and, transitively, Vue components) into the server process.
 *
 * Phase 2 replaces this with a real Pinia instance for the background stores;
 * the modal store stays stubbed permanently, since a headless process has no
 * dialogs. Failures are logged and the original error still propagates,
 * because `handleSQLiteError` re-throws after showing its dialog.
 */
import { log } from '../log.js';

/**
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
