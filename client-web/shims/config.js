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
    // Found live: a naive single-value-per-key cache is wrong whenever the
    // same key is read with two different `defaultValue`s (real case —
    // src/stores/auth.js:127 reads `lastUserLoggedIn` with default `''` at
    // store setup, then autoLoginAfterMounted() at src/stores/auth.js:207
    // reads the *same* key with the implicit default `null` to ask "does
    // this key exist at all?"). A key-only cache serves the second call the
    // first call's `''`, so `!== null` is wrongly true on a database that
    // has never had a user log in, and auto-login proceeds to call
    // getCurrentUser() against a session with no cookies — a pointless
    // 401 "Missing Credentials", not a real error. The real (unaliased)
    // configRepository has no such cache — every call independently asks
    // SQLite with its own default — so this is a gap this shim introduced,
    // not upstream behaviour to route around. `#variants` caches per
    // (method, key, defaultValue) tuple, correct but only as cache-friendly
    // as the caller's own defaults happen to agree; `#written` short-circuits
    // that entirely once a real setX() has actually run for a key, since at
    // that point the value is definitive regardless of what default some
    // other call site asks for.
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
        // Stale defaulted misses under the old value are no longer valid —
        // the key definitely exists now, so #get's #written check above
        // takes over regardless of what default a future call asks for.
        this.#variants.delete(key);
        await rpcCall('config', method, [key, value]);
    }
}

const configRepository = new ClientConfigRepository();
export default configRepository;
export { ClientConfigRepository };
