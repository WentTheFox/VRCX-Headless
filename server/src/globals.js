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
import { installPipelineRelayPolyfill } from './pipeline-relay.js';

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
 * Reproduces `GetVersion()` in `Dotnet/Program.cs:67` — a 7-character
 * trailing segment marks a nightly build. VRChat rate-limits generic user
 * agents, so this is functional, not cosmetic. Was `server/src/vrchat.js`'s
 * own export before phase 2b step 7 deleted that scaffold; lives here now
 * since both `server/src/cli.js` (display) and
 * `installWebSocketUserAgentPolyfill` below (the actual pipeline handshake)
 * need it.
 *
 * @param {string} version contents of the repo-root `Version` file
 * @returns {string}
 */
export function buildUserAgent(version) {
    const parts = String(version).trim().split('-');
    return parts.length > 0 && parts[parts.length - 1].length === 7
        ? `VRCX Nightly ${version}`
        : `VRCX ${version}`;
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
 * Node's global `WebSocket` (undici) sends no default `User-Agent`, unlike a
 * browser, which always attaches its own. Cloudflare in front of
 * `pipeline.vrchat.cloud` drops the handshake silently without one —
 * confirmed by hand-rolling the HTTP upgrade over raw TLS during phase 2a:
 * succeeds with the header, never reaches `onopen` without it, surfacing
 * only as an immediate `onerror` + 1006 close and an endless 5 s reconnect
 * loop. `server/src/vrchat.js`'s own `PipelineConnection` (phase 2a) fixed
 * this by passing `{ headers: {...} }` on its own `new WebSocket()` call —
 * but phase 2b step 7 deleted that scaffold in favour of the real
 * `src/services/websocket.js:82`, which makes the identical bare
 * `new WebSocket(url)` call. Invariant 1 forbids editing that call site, so
 * this wraps the *global* constructor instead — confirmed live (2026-08-14):
 * `pipeline` failed with a `WebSocket Error` toast every 5s exactly like the
 * original bug, until this was added.
 *
 * Only patches the zero-options call shape (`new WebSocket(url)`), which is
 * the one real call site actually uses; a call that already passes its own
 * second argument is left alone rather than merged with, since nothing in
 * the closure does that today and guessing at a merge strategy for a case
 * that doesn't exist yet is more likely to be wrong than helpful.
 */
export function installWebSocketUserAgentPolyfill() {
    if (globalThis.WebSocket?.__vrcxUserAgentPatched) {
        return;
    }
    const NativeWebSocket = globalThis.WebSocket;
    const userAgent = buildUserAgent(readVersion());
    class UserAgentWebSocket extends NativeWebSocket {
        /**
         * @param {string | URL} url
         * @param {*} [options]
         */
        constructor(url, options) {
            super(
                url,
                options === undefined
                    ? { headers: { 'User-Agent': userAgent } }
                    : options
            );
        }
    }
    UserAgentWebSocket.__vrcxUserAgentPatched = true;
    globalThis.WebSocket = UserAgentWebSocket;
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
 * `window = globalThis` (the previous behaviour) makes `typeof window !==
 * 'undefined'` true everywhere, which defeats the SSR guards in
 * `@tanstack/query-core` and `@vueuse/core` — nothing in the current server
 * closure imports either yet, but that is exactly the kind of thing an
 * upstream merge adds without anyone noticing until it silently starts
 * running browser-only code paths here. `window` needs to stop being a
 * literal alias for `globalThis`, so that random properties *other* code
 * adds to `globalThis` (an unrelated library, a future polyfill) don't
 * silently leak onto `window` and vice versa.
 *
 * That is not the same thing as "narrow the property list", which was this
 * function's first version and turned out to be wrong: `services/
 * appConfig.js` (`$debug`, `utils`, `dayjs`), `services/database/index.js`
 * (`database`), `services/config.js` (`configRepository`), `services/
 * sqlite.js` (`sqliteService`), `services/webapi.js` (`webApiService`),
 * `services/gameLog.js` (`gameLogService`) and `api/index.js` (`request`)
 * all do `window.X = Y` at module load — and in a real browser, where
 * `window` *is* the global object, that assignment also creates a bare
 * top-level `X`. `src/**` relies on exactly that everywhere it reads one of
 * these as a plain identifier instead of `window.X` — found live, not
 * predicted: `stores/vrcxUpdater.js:304` reads bare `webApiService` and
 * threw `ReferenceError: webApiService is not defined` the first time
 * `whoami` actually exercised that code path (phase 2b step 7), because a
 * plain object narrowed to a fixed property list does not replicate that.
 *
 * So `window` is a `Proxy` instead: reads are narrow (only `matchMedia` and
 * `crypto` are seeded — see below), but every *write* through `window.X = Y`
 * mirrors onto `globalThis[X]` too, same as a real browser. This still
 * solves the actual SSR-guard problem (`globalThis` pollution from
 * elsewhere no longer appears on `window`, and `window` writes don't
 * silently become permanent globalThis fixtures except for the ones `src/**`
 * itself explicitly makes), while not breaking every bare-identifier read
 * of something `src/**` assigns onto `window` on purpose.
 *
 * The two reads seeded up front are `window.matchMedia`
 * (`stores/settings/appearance.js:529` — written across two lines,
 * `window\n    .matchMedia(...)`, easy to miss with a one-line grep) and
 * `window.crypto` (`services/security.js`, reached through `stores/auth.js`;
 * this is CLAUDE.md §8's own "carried forward" note — `window.crypto.subtle`
 * exists natively in Node). Must run after `installMatchMediaPolyfill()`,
 * which is what `globalThis.matchMedia` here actually resolves to.
 */
export function installNarrowWindowPolyfill() {
    if (globalThis.window !== undefined) {
        return;
    }
    const store = {
        matchMedia: globalThis.matchMedia,
        crypto: globalThis.crypto
    };
    globalThis.window = new Proxy(store, {
        set(target, prop, value) {
            target[prop] = value;
            if (typeof prop === 'string') {
                globalThis[prop] = value;
            }
            return true;
        }
    });
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
    installCloseEventPolyfill();
    installWebSocketUserAgentPolyfill();
    installPipelineRelayPolyfill();
    installMatchMediaPolyfill();
    installVrcxStoragePolyfill();
    installAppApiPolyfill();
    installSpeechSynthesisPolyfill();
    installDocumentPolyfill();
    installNarrowWindowPolyfill();
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
