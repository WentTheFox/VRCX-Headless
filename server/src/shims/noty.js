/**
 * Headless stand-in for `noty`.
 *
 * `src/stores/auth.js` and `src/coordinators/authCoordinator.js` show a
 * login/logout greeting toast via `new Noty({ type, text }).show()` — the
 * only call shape either uses. The real package runs
 * `document.addEventListener` at *module load* time (`noty/lib/noty.js`),
 * not deferred to construction or `.show()`, so it crashes on import alone;
 * unlike `vue-sonner` (`server/src/shims/toast.js`) it can't be deferred to
 * call time either.
 *
 * `text` carries inline HTML (e.g. `<strong>name</strong>` for emphasis in
 * the real toast), stripped here since log lines have no renderer.
 */
import { log } from '../log.js';

export default class Noty {
    /**
     * @param {{ type?: string, text?: string }} [options]
     */
    constructor(options = {}) {
        this.type = options.type ?? 'info';
        this.text = String(options.text ?? '').replace(/<[^>]*>/g, '');
    }

    show() {
        const level = this.type === 'error' ? 'error' : 'info';
        log[level](`noty: ${this.text}`);
        return this;
    }

    close() {}
}
