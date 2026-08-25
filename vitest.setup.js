/**
 * Vitest global setup file.
 * Loads English locale messages into i18n so that
 * translation calls return expected values in tests.
 *
 * Provides global stubs for CefSharp IPC bindings.
 */

import { ref } from 'vue';

import { i18n } from './src/plugins/i18n';

import en from './src/localization/en.json';

const noopAsync = () => Promise.resolve('');

globalThis.AppApi = new Proxy({}, { get: () => noopAsync });
globalThis.WebApi = new Proxy({}, { get: () => noopAsync });
globalThis.VRCXStorage = new Proxy({}, { get: () => noopAsync });
globalThis.SQLite = new Proxy({}, { get: () => noopAsync });
globalThis.LogWatcher = new Proxy({}, { get: () => noopAsync });
globalThis.Discord = new Proxy({}, { get: () => noopAsync });
globalThis.AssetBundleManager = new Proxy({}, { get: () => noopAsync });

// ResizeObserver polyfill (needed by @dnd-kit/vue at import time)
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

// Browser API stubs not available in jsdom
globalThis.speechSynthesis = {
    getVoices: () => [],
    cancel: () => {},
    speak: () => {}
};

// matchMedia polyfill (standard jsdom workaround)
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
    }))
});

// localStorage polyfill (jsdom may not provide a full implementation)
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.clear !== 'function') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
        clear: () => store.clear(),
        get length() {
            return store.size;
        },
        key: (index) => [...store.keys()][index] ?? null
    };
}

// Notification API stub
globalThis.Notification = class {
    static permission = 'denied';
    static requestPermission = vi.fn().mockResolvedValue('denied');
    constructor() {}
    close() {}
};

// Mock worker-timers to use native timers (workers unavailable in jsdom)
vi.mock('worker-timers', () => ({
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
}));

// The real router (src/plugins/router.js) eagerly imports every view to
// build its route table -- fine in a real app, but src/stores/gallery.js
// now imports it directly (upstream's "Add favorite functionality for
// prints" change), so any test whose store graph transitively reaches
// gallery.js pulls that whole view tree in too, including files that read
// `i18n.global` at module scope and crash on a transient circular-import
// ordering issue through the `@/plugins` barrel. This global default keeps
// that from ambushing tests that never intended to exercise the router at
// all; a test file's own local `vi.mock(..., '/plugins/router', ...)` (the
// established per-file pattern already used where router behavior is
// actually under test) still takes precedence over this one, since Vitest
// resolves mocks by module identity and the later-registered one wins.
vi.mock('./src/plugins/router', () => ({
    router: {
        beforeEach: () => {},
        push: () => {},
        replace: () => {},
        currentRoute: ref({ path: '/', name: '', meta: {}, params: {}, query: {} }),
        isReady: () => Promise.resolve(true)
    },
    initRouter: () => {}
}));

i18n.global.setLocaleMessage('en', en);
