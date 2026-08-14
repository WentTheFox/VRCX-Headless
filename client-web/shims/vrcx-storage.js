/**
 * Client-side `window.VRCXStorage` (phase 4). Per §1's ownership table this
 * is genuinely desktop-owned (window geometry etc.) — §9's "Known
 * limitations" already calls for "a stub" here, not full parity. Backed by
 * `localStorage` rather than the server's in-memory `Map`
 * (`server/src/globals.js`'s `installVrcxStoragePolyfill`, which this
 * mirrors method-for-method): unlike a headless process, a browser tab
 * benefits from actually surviving a reload, and `localStorage` is the
 * closest browser-native analogue to "device-local persistent storage".
 */
const PREFIX = 'vrcx-storage:';

export const vrcxStorageTarget = {
    async Get(key) {
        return localStorage.getItem(PREFIX + key) ?? '';
    },
    async Set(key, value) {
        localStorage.setItem(PREFIX + key, value);
    },
    async Save() {},
    async GetAll() {
        /** @type {Record<string, string>} */
        const all = {};
        for (let i = 0; i < localStorage.length; i++) {
            const storageKey = localStorage.key(i);
            if (storageKey?.startsWith(PREFIX)) {
                all[storageKey.slice(PREFIX.length)] =
                    localStorage.getItem(storageKey);
            }
        }
        return JSON.stringify(all);
    },
    Remove(key) {
        localStorage.removeItem(PREFIX + key);
    },
    async GetArray(key) {
        try {
            const array = JSON.parse(
                localStorage.getItem(PREFIX + key) ?? '[]'
            );
            if (Array.isArray(array)) return array;
        } catch {
            // fall through to the [] default below
        }
        return [];
    },
    SetArray(key, value) {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    },
    async GetObject(key) {
        try {
            const object = JSON.parse(
                localStorage.getItem(PREFIX + key) ?? '{}'
            );
            if (object === Object(object)) return object;
        } catch {
            // fall through to the {} default below
        }
        return {};
    },
    SetObject(key, value) {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    }
};
