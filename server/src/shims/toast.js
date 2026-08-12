/**
 * Headless stand-in for `vue-sonner`.
 *
 * `src/services/request.js`, `src/services/websocket.js` and 13 coordinators
 * report every API failure by raising a toast. There is no UI here, so they
 * become structured log lines. From phase 3 these also become events on the
 * client stream, so a browser can surface what the desktop app would have shown.
 *
 * The call signature is `toast.error(message, { description, position })`, plus
 * `toast(message)` used directly — hence the callable object.
 */
import { log } from '../log.js';

/**
 * @param {string} level
 * @returns {(message: unknown, options?: { description?: string }) => void}
 */
function channel(level) {
    return (message, options) => {
        const text =
            typeof message === 'string' ? message : JSON.stringify(message);
        log[level](`toast: ${text}`, options?.description);
    };
}

/**
 * @param {unknown} message
 * @param {{ description?: string }} [options]
 */
export function toast(message, options) {
    channel('info')(message, options);
}

toast.success = channel('info');
toast.info = channel('info');
toast.message = channel('info');
toast.warning = channel('warn');
toast.error = channel('error');
toast.loading = channel('debug');
toast.dismiss = () => {};
toast.custom = channel('info');
toast.promise = (promise) => promise;

export default toast;
