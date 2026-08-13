/**
 * Installs the compile-time globals that Vite injects into `src/**` via its
 * `define` block (see src/vite.config.js), plus the minimal `window` surface
 * the data layer touches.
 *
 * Keep this in sync with the `define` block on every upstream merge — see the
 * change-detection checklist in CLAUDE.md.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);

/**
 * @returns {string} the contents of the repo-root `Version` file
 */
export function readVersion() {
    try {
        return readFileSync(path.join(repoRoot, 'Version'), 'utf8').trim();
    } catch {
        return '0.0.0';
    }
}

/**
 * Node has `WebSocket` but not `CloseEvent`.
 *
 * This matters more than it looks: `src/services/websocket.js:118` handles
 * `socket.onerror` by *constructing* a CloseEvent and calling its own
 * `onclose` with it, and `onclose` is what schedules the 5 s reconnect. Without
 * the polyfill, a network error throws a ReferenceError inside the error
 * handler and the pipeline connection dies permanently instead of reconnecting.
 */
export function installCloseEventPolyfill() {
    if (typeof globalThis.CloseEvent === 'function') {
        return;
    }
    globalThis.CloseEvent = class CloseEvent extends Event {
        /**
         * @param {string} type
         * @param {{ code?: number, reason?: string, wasClean?: boolean }} [init]
         */
        constructor(type, init = {}) {
            super(type, init);
            this.code = init.code ?? 0;
            this.reason = init.reason ?? '';
            this.wasClean = init.wasClean ?? false;
        }
    };
}

/**
 * `src/stores/settings/appearance.js` calls
 * `window.matchMedia('(prefers-color-scheme: dark)').addEventListener(...)`
 * unconditionally at store-setup scope, to react to OS theme changes. There
 * is no OS theme here — `matches: false` (light) is a neutral, arbitrary
 * default, since nothing server-side actually reads it visually; the point
 * is only that the call doesn't throw and later `removeEventListener`
 * calls (e.g. on hot-reload) don't either.
 */
export function installMatchMediaPolyfill() {
    if (typeof globalThis.matchMedia === 'function') {
        return;
    }
    globalThis.matchMedia = () => ({
        matches: false,
        media: '',
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
    });
}

/**
 * `VRCXStorage` (`VRCX.json`) is explicitly desktop-owned (CLAUDE.md §1 —
 * "genuinely machine-local: window geometry etc."), injected client-side by
 * `src/plugins/interopApi.js`, which the server never runs. But several
 * stores and coordinators reference the bare global directly regardless —
 * `src/stores/{vrcx,friend}.js`, `src/stores/settings/general.js`,
 * `src/coordinators/{memo,friendSync}Coordinator.js` (grepped) — and phase
 * 2b step 5's eager `createGlobalStores()` reaches every one of them at
 * store-setup time, not just on demand. There being no sensible
 * headless equivalent of "this machine's window position" is exactly why
 * this stays an in-memory stub rather than growing into real persistence:
 * `Get` after `Set` behaves consistently *within a process*, but nothing
 * survives a restart, matching upstream's own first-run behaviour when
 * `VRCX.json` doesn't exist yet (`Get` on an unset key returns `''`, which
 * `src/stores/vrcx.js:154` already treats as "not configured").
 *
 * `GetArray`/`SetArray`/`GetObject`/`SetObject` are upstream's own derived
 * methods, normally added by `src/services/jsonStorage.js`'s `init()` (only
 * called from the client-only `interopApi.js`) — reimplemented here
 * directly from `Get`/`Set` rather than importing that file, since nothing
 * else in it is needed and importing it would mean also reproducing the
 * `new vrcxJsonStorage(VRCXStorage)` client bootstrap sequence.
 */
export function installVrcxStoragePolyfill() {
    if (globalThis.VRCXStorage !== undefined) {
        return;
    }
    const data = new Map();
    globalThis.VRCXStorage = {
        async Get(key) {
            return data.get(key) ?? '';
        },
        async Set(key, value) {
            data.set(key, value);
        },
        async Save() {},
        async GetAll() {
            return JSON.stringify(Object.fromEntries(data));
        },
        Remove(key) {
            data.delete(key);
        },
        async GetArray(key) {
            try {
                const array = JSON.parse(data.get(key) ?? '[]');
                if (Array.isArray(array)) return array;
            } catch {
                // fall through to the [] default below
            }
            return [];
        },
        SetArray(key, value) {
            data.set(key, JSON.stringify(value));
        },
        async GetObject(key) {
            try {
                const object = JSON.parse(data.get(key) ?? '{}');
                if (object === Object(object)) return object;
            } catch {
                // fall through to the {} default below
            }
            return {};
        },
        SetObject(key, value) {
            data.set(key, JSON.stringify(value));
        }
    };
}

/**
 * Define `LINUX` / `WINDOWS` / `VERSION` / `NIGHTLY` as real globals so that
 * `src/**` — which references them as bare identifiers — can run under Node.
 *
 * Both platform flags are false on the server: it is neither the CEF/Windows
 * build nor the Electron/Linux build. `src/services/sqlite.js` branches only on
 * `LINUX`, so this selects the plain `SQLite.Execute` path; the shim in
 * ./shims/sqlite.js implements `ExecuteJson` too, so either value works.
 */
export function installGlobals() {
    if (globalThis.window === undefined) {
        globalThis.window = globalThis;
    }
    installCloseEventPolyfill();
    installMatchMediaPolyfill();
    installVrcxStoragePolyfill();
    if (globalThis.LINUX === undefined) {
        globalThis.LINUX = false;
    }
    if (globalThis.WINDOWS === undefined) {
        globalThis.WINDOWS = false;
    }
    if (globalThis.VERSION === undefined) {
        globalThis.VERSION = readVersion();
    }
    if (globalThis.NIGHTLY === undefined) {
        globalThis.NIGHTLY = false;
    }
}
