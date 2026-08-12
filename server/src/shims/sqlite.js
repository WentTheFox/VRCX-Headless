/**
 * Headless implementation of the `window.SQLite` contract.
 *
 * This is a behavioural port of Dotnet/SQLite.cs. `src/services/sqlite.js` is
 * the only consumer and is used unmodified, so the contract below must match
 * the C# one exactly:
 *
 *   Execute(sql, args)        -> object[][]  (rows as POSITIONAL arrays)
 *   ExecuteJson(sql, args)    -> string      (JSON of the above)
 *   ExecuteNonQuery(sql, args)-> number      (rows affected)
 *
 * Three fidelity requirements, each load-bearing:
 *
 *  1. Rows are positional arrays, not objects. Every caller in
 *     `src/services/database/**` indexes `row[0]`, `row[1]`, ... and depends on
 *     `SELECT` column order. Object rows would also silently collapse duplicate
 *     column names in joins.
 *  2. Unknown named parameters are ignored, matching System.Data.SQLite, which
 *     accepts parameters the statement never references.
 *  3. Error messages are SQLite's native text. `handleSQLiteError` in
 *     `src/services/sqlite.js` string-matches on 'database disk image is
 *     malformed', 'database or disk is full', 'database is locked' and
 *     'disk I/O error' to decide which dialog to raise.
 */
import { DatabaseSync } from 'node:sqlite';

/**
 * Coerce a JS value into something node:sqlite can bind.
 *
 * node:sqlite accepts only null / number / bigint / string / Uint8Array and
 * throws on anything else. System.Data.SQLite is more forgiving, and the data
 * layer relies on that: optional VRChat API fields arrive as `undefined`, and
 * flags are passed as booleans.
 *
 * @param {unknown} value
 * @returns {null | number | bigint | string | Uint8Array}
 */
function coerceParameter(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' || typeof value === 'bigint') {
        return value;
    }
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof Date) {
        // Matches what the data layer already does at its call sites
        // (`new Date().toJSON()`).
        return value.toJSON();
    }
    // Deliberately not stringified: an object here is a bug at the call site,
    // and System.Data.SQLite would reject it too.
    throw new TypeError(
        `Cannot bind value of type ${Object.prototype.toString.call(value)} to a SQLite parameter`
    );
}

/**
 * `args` arrives either as a plain object (CEF path) or a Map (Electron path);
 * `src/services/sqlite.js` builds the Map itself when `LINUX` is true.
 *
 * @param {Record<string, unknown> | Map<string, unknown> | null | undefined} args
 * @returns {Record<string, unknown> | undefined}
 */
function normaliseArgs(args) {
    if (args === null || args === undefined) {
        return undefined;
    }
    const entries =
        args instanceof Map ? [...args.entries()] : Object.entries(args);
    if (entries.length === 0) {
        return undefined;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of entries) {
        out[key] = coerceParameter(value);
    }
    return out;
}

export class SQLiteShim {
    /** @type {DatabaseSync | null} */
    #db = null;
    /** @type {string} */
    #location = '';

    /**
     * @param {string} location absolute path to the VRCX.sqlite3 file
     * @param {{ readOnly?: boolean }} [options]
     */
    open(location, options = {}) {
        if (this.#db) {
            throw new Error(`SQLite is already open at ${this.#location}`);
        }
        this.#location = location;
        this.#db = new DatabaseSync(location, {
            readOnly: options.readOnly === true
        });

        // Mirrors the connection string in Dotnet/SQLite.cs:37.
        this.#db.exec('PRAGMA locking_mode=NORMAL');
        this.#db.exec('PRAGMA busy_timeout=5000');
        if (!options.readOnly) {
            this.#db.exec('PRAGMA journal_mode=WAL');
        }
        return this;
    }

    close() {
        this.#db?.close();
        this.#db = null;
    }

    get isOpen() {
        return this.#db !== null;
    }

    get location() {
        return this.#location;
    }

    /**
     * @returns {DatabaseSync}
     */
    #require() {
        if (!this.#db) {
            throw new Error('SQLite connection is not open; call open() first');
        }
        return this.#db;
    }

    /**
     * @param {string} sql
     * @param {Record<string, unknown> | Map<string, unknown> | null} [args]
     * @returns {unknown[][]} rows as positional arrays
     */
    Execute(sql, args = null) {
        const statement = this.#require().prepare(sql);
        statement.setReturnArrays(true);
        statement.setAllowUnknownNamedParameters(true);
        const params = normaliseArgs(args);
        return params ? statement.all(params) : statement.all();
    }

    /**
     * @param {string} sql
     * @param {Record<string, unknown> | Map<string, unknown> | null} [args]
     * @returns {string} JSON-encoded rows
     */
    ExecuteJson(sql, args = null) {
        return JSON.stringify(this.Execute(sql, args));
    }

    /**
     * @param {string} sql
     * @param {Record<string, unknown> | Map<string, unknown> | null} [args]
     * @returns {number} rows affected
     */
    ExecuteNonQuery(sql, args = null) {
        const db = this.#require();
        const params = normaliseArgs(args);

        // `prepare()` rejects multi-statement SQL, which the migration layer
        // does not use, but `VACUUM`/`PRAGMA` are fine either way.
        const statement = db.prepare(sql);
        statement.setAllowUnknownNamedParameters(true);
        const result = params ? statement.run(params) : statement.run();
        return Number(result.changes ?? 0);
    }
}

export const sqliteShim = new SQLiteShim();

/**
 * Publish the shim as `window.SQLite`, which is where `src/services/sqlite.js`
 * looks for it. Must be called before importing any module that touches the DB.
 *
 * @param {SQLiteShim} [instance]
 */
export function installSQLiteGlobal(instance = sqliteShim) {
    globalThis.SQLite = instance;
    return instance;
}
