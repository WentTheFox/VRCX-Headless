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

import { log } from './log.js';

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
 * `AppApi` is a C# object bound over CEF/Electron IPC by
 * `src/plugins/interopApi.js` (the client's only injection point), backing
 * ~81 methods spread across `Dotnet/AppApi/**` — screenshot handling, VR
 * overlay, registry, game-process detection, window focus, and so on. None
 * of it has a headless equivalent (phase 2b step 9's own framing: "a Proxy
 * over the ~81 methods returning no-ops"), and unlike `VRCXStorage` there's
 * no fixed method list to enumerate up front — every call site in `src/**`
 * is a bare `AppApi.SomeMethod(...)`, so a `Proxy` answers arbitrary method
 * names instead of hand-listing all 81.
 *
 * Every call site found in the store/coordinator closure is fire-and-forget
 * (grepped — nothing reads a return value), so a generic async no-op is
 * enough; `CheckGameRunning`, `IPCAnnounceStart`, `FlashWindow` and
 * `PopulateImageHosts` are the ones actually reached on the server's normal
 * paths (`updateLoop.js`, `auth.js`, `userCoordinator.js`) rather than only
 * from UI event handlers that never fire headless, but none needed special
 * handling once confirmed. Logged at `debug`, not `info` like
 * `server/src/shims/app-actions.js`'s UI-action suppressions — some of
 * these (`CheckGameRunning`) are on `updateLoop`'s poll path and would
 * otherwise spam the log every cycle.
 *
 * Phase 4 will want this same shape client-side for the web client's own
 * `capabilities` gating — kept server-only for now rather than factored out
 * pre-emptively, since there's nothing to share yet but the idea.
 *
 * One method needed a real return value rather than the blanket
 * `undefined`, found the same way as `matchMedia`/`VRCXStorage` — by
 * actually eager-instantiating every store and reading the next crash:
 * `GetVersion()` feeds `src/stores/vrcxUpdater.js`'s update-check logic
 * unconditionally at setup scope, with no null-check on the result before
 * calling `.replace()` on it. `VERSION` (installed below, read from the
 * repo-root `Version` file) is what the real implementation would return
 * anyway.
 */
export function installAppApiPolyfill() {
    if (globalThis.AppApi !== undefined) {
        return;
    }
    const overrides = {
        GetVersion: async () => globalThis.VERSION
    };
    const cache = new Map();
    globalThis.AppApi = new Proxy(
        {},
        {
            get(_target, prop) {
                if (typeof prop !== 'string') {
                    return undefined;
                }
                if (prop in overrides) {
                    return overrides[prop];
                }
                let fn = cache.get(prop);
                if (!fn) {
                    fn = async (...args) => {
                        log.debug(`AppApi.${prop} suppressed (headless)`, {
                            args
                        });
                    };
                    cache.set(prop, fn);
                }
                return fn;
            }
        }
    );
}

/**
 * `src/stores/settings/notifications.js` calls `speechSynthesis.getVoices()`
 * at store-setup scope, and `.cancel()`/`.speak()` from its TTS actions.
 * This is CLAUDE.md §3.7's `speechSynthesis` entry ("phase 5: route to a
 * desktop agent") — real TTS output only ever makes sense coming out of a
 * speaker on someone's desktop, so this stays a stub through phase 2b
 * regardless; it exists only so eager store instantiation (step 5) doesn't
 * crash on the empty voice list, not as an attempt at the phase 5 routing.
 */
export function installSpeechSynthesisPolyfill() {
    if (globalThis.speechSynthesis !== undefined) {
        return;
    }
    globalThis.speechSynthesis = {
        getVoices: () => [],
        cancel() {},
        speak() {}
    };
}

/**
 * A handful of stores touch `document.*` directly rather than through
 * `src/shared/utils/appActions.js` or `base/ui.js` (both already stubbed —
 * `server/src/shims/app-actions.js`, `server/src/shims/base-ui.js`):
 * `document.documentElement.classList` for CSS-class-driven UI density/
 * accessibility toggles (`src/stores/settings/appearance.js`, two call
 * sites reached eagerly at store-setup time), plus `getElementById` /
 * `querySelector` / `querySelectorAll` for one-off cleanup of injected
 * `<style>` tags and upload-button state (`src/stores/auth.js`,
 * `src/stores/gallery.js`, `src/coordinators/imageUploadCoordinator.js`).
 * Bounded surface, grepped across the whole store/coordinator closure —
 * extend it if a new call site shows up rather than reaching for jsdom.
 *
 * `createElement` is not one of those call sites — it exists because
 * `@vue/runtime-dom` (pulled in by the bare `'vue'` package, which is used
 * everywhere for `ref`/`computed`/`watch`) does `doc &&
 * doc.createElement("template")` at *module scope*, as a `<template>`
 * feature check, the moment anything imports `'vue'`. That's harmless while
 * `document` is `undefined` (the `&&` short-circuits) but breaks once this
 * polyfill makes `document` truthy without providing the one method that
 * gets called unconditionally at import time.
 */
export function installDocumentPolyfill() {
    if (globalThis.document !== undefined) {
        return;
    }
    const classList = {
        add() {},
        remove() {},
        toggle() {
            return false;
        },
        contains() {
            return false;
        }
    };
    function createElement() {
        return {
            classList,
            style: {},
            setAttribute() {},
            removeAttribute() {},
            appendChild() {},
            removeChild() {},
            addEventListener() {},
            removeEventListener() {}
        };
    }
    globalThis.document = {
        documentElement: { classList },
        createElement,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => []
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
    installAppApiPolyfill();
    installSpeechSynthesisPolyfill();
    installDocumentPolyfill();
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
