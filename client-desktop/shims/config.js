/**
 * Client-side replacement for `src/services/config.js` (phase 5), aliased
 * in for the Electron/Linux build. Same shape as `client-web/shims/config.js`
 * — same 13 method names (invariant 4), same write-through cache — only the
 * RPC transport differs (`./agent-rpc.js`).
 */
import { rpcCall } from './agent-rpc.js';

class ClientConfigRepository {
    // Same fix as client-web/shims/config.js — see its comment for the live
    // bug this closes (a key-only cache serving one call site's default to
    // a different call site's request for the same key).
    /** @type {Map<string, Map<string, any>>} */
    #variants = new Map();
    /** @type {Map<string, any>} */
    #written = new Map();

    async init() {}

    async remove(key) {
        this.#variants.delete(key);
        this.#written.delete(key);
        await rpcCall('config', 'remove', [key]);
    }

    async getString(key, defaultValue = null) {
        return this.#get('getString', key, defaultValue);
    }

    async setString(key, value) {
        return this.#set('setString', key, value);
    }

    async getBool(key, defaultValue = null) {
        return this.#get('getBool', key, defaultValue);
    }

    async setBool(key, value) {
        return this.#set('setBool', key, value);
    }

    async getInt(key, defaultValue = null) {
        return this.#get('getInt', key, defaultValue);
    }

    async setInt(key, value) {
        return this.#set('setInt', key, value);
    }

    async getFloat(key, defaultValue = null) {
        return this.#get('getFloat', key, defaultValue);
    }

    async setFloat(key, value) {
        return this.#set('setFloat', key, value);
    }

    async getObject(key, defaultValue = null) {
        return this.#get('getObject', key, defaultValue);
    }

    async setObject(key, value) {
        return this.#set('setObject', key, value);
    }

    async getArray(key, defaultValue = null) {
        return this.#get('getArray', key, defaultValue);
    }

    async setArray(key, value) {
        return this.#set('setArray', key, value);
    }

    /**
     * @param {string} method
     * @param {string} key
     * @param {any} defaultValue
     */
    async #get(method, key, defaultValue) {
        if (this.#written.has(key)) return this.#written.get(key);
        const variant = `${method}:${JSON.stringify(defaultValue)}`;
        let variants = this.#variants.get(key);
        if (variants?.has(variant)) return variants.get(variant);
        const value = await rpcCall('config', method, [key, defaultValue]);
        if (!variants) {
            variants = new Map();
            this.#variants.set(key, variants);
        }
        variants.set(variant, value);
        return value;
    }

    /**
     * @param {string} method
     * @param {string} key
     * @param {any} value
     */
    async #set(method, key, value) {
        this.#written.set(key, value);
        this.#variants.delete(key);
        await rpcCall('config', method, [key, value]);
    }
}

const configRepository = new ClientConfigRepository();
export default configRepository;
export { ClientConfigRepository };
