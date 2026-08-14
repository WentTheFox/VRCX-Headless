/**
 * Client-side replacement for `src/services/config.js` (phase 4), aliased
 * in under `PLATFORM=web`. Same 13 method names as the real
 * `ConfigRepository` (invariant 4 — byte-identical signatures, ~540 call
 * sites): `init`, `remove`, and `get`/`set` for `String`/`Bool`/`Int`/
 * `Float`/`Object`/`Array`. Each is a `POST /api/rpc` call against the
 * `config` target (the real, unmodified `configRepository` running
 * server-side), with a flat write-through cache so a `getX` right after a
 * `setX` in the same session doesn't round-trip.
 *
 * `init()` is a no-op here — the real method just runs
 * `CREATE TABLE IF NOT EXISTS configs`, which the server already did
 * (`server/src/cli.js`'s `bootstrapSession`/`serve`) long before any client
 * connects.
 */
import { rpcCall } from './rpc-client.js';

class ClientConfigRepository {
    #cache = new Map();

    async init() {}

    async remove(key) {
        this.#cache.delete(key);
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
        if (this.#cache.has(key)) return this.#cache.get(key);
        const value = await rpcCall('config', method, [key, defaultValue]);
        this.#cache.set(key, value);
        return value;
    }

    /**
     * @param {string} method
     * @param {string} key
     * @param {any} value
     */
    async #set(method, key, value) {
        this.#cache.set(key, value);
        await rpcCall('config', method, [key, value]);
    }
}

const configRepository = new ClientConfigRepository();
export default configRepository;
export { ClientConfigRepository };
