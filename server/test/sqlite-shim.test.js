/**
 * Fidelity tests for the node:sqlite implementation of the `window.SQLite`
 * contract. Each case pins a behaviour of Dotnet/SQLite.cs that the unmodified
 * `src/services/**` data layer depends on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteShim } from '../src/shims/sqlite.js';

describe('SQLiteShim', () => {
    /** @type {SQLiteShim} */
    let sqlite;

    beforeEach(() => {
        sqlite = new SQLiteShim().open(':memory:');
        sqlite.ExecuteNonQuery(
            'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, note TEXT)'
        );
    });

    afterEach(() => {
        sqlite.close();
    });

    it('returns rows as positional arrays, not objects', () => {
        sqlite.ExecuteNonQuery(
            'INSERT INTO t (id, name, flag) VALUES (@id, @name, @flag)',
            { '@id': 1, '@name': 'alice', '@flag': 7 }
        );

        const rows = sqlite.Execute('SELECT id, name, flag FROM t');

        expect(rows).toEqual([[1, 'alice', 7]]);
        expect(Array.isArray(rows[0])).toBe(true);
    });

    it('preserves duplicate column names, which object rows would collapse', () => {
        // Joins in src/services/database/** select same-named columns from two
        // tables; object rows would silently drop one of them.
        const rows = sqlite.Execute("SELECT 1 AS id, 2 AS id, 'x' AS id");
        expect(rows).toEqual([[1, 2, 'x']]);
    });

    it('preserves SELECT column order', () => {
        sqlite.ExecuteNonQuery("INSERT INTO t (id, name) VALUES (1, 'alice')");
        expect(sqlite.Execute('SELECT name, id FROM t')).toEqual([
            ['alice', 1]
        ]);
        expect(sqlite.Execute('SELECT id, name FROM t')).toEqual([
            [1, 'alice']
        ]);
    });

    it('ignores named parameters the statement does not use', () => {
        // System.Data.SQLite accepts surplus parameters; node:sqlite throws
        // unless setAllowUnknownNamedParameters is enabled.
        expect(() =>
            sqlite.Execute('SELECT @used', { '@used': 1, '@unused': 2 })
        ).not.toThrow();
    });

    it('coerces values node:sqlite cannot bind but System.Data.SQLite accepts', () => {
        sqlite.ExecuteNonQuery(
            'INSERT INTO t (id, name, flag, note) VALUES (@id, @name, @flag, @note)',
            {
                '@id': 1,
                // Optional VRChat API fields arrive as undefined.
                '@name': undefined,
                '@flag': true,
                '@note': new Date(0)
            }
        );

        expect(sqlite.Execute('SELECT name, flag, note FROM t')).toEqual([
            [null, 1, '1970-01-01T00:00:00.000Z']
        ]);
    });

    it('rejects values that are a bug at the call site', () => {
        expect(() => sqlite.Execute('SELECT @x', { '@x': { a: 1 } })).toThrow(
            /Cannot bind value/
        );
    });

    it('accepts args as a Map, as the Electron path passes them', () => {
        // src/services/sqlite.js converts args to a Map when LINUX is true.
        sqlite.ExecuteNonQuery(
            'INSERT INTO t (id, name) VALUES (@id, @name)',
            new Map([
                ['@id', 1],
                ['@name', 'alice']
            ])
        );
        expect(sqlite.Execute('SELECT name FROM t')).toEqual([['alice']]);
    });

    it('ExecuteJson returns the JSON encoding of Execute', () => {
        sqlite.ExecuteNonQuery("INSERT INTO t (id, name) VALUES (1, 'alice')");
        const sql = 'SELECT id, name FROM t';
        expect(sqlite.ExecuteJson(sql)).toBe(
            JSON.stringify(sqlite.Execute(sql))
        );
    });

    it('ExecuteNonQuery returns the number of affected rows', () => {
        expect(
            sqlite.ExecuteNonQuery("INSERT INTO t (id, name) VALUES (1, 'a')")
        ).toBe(1);
        sqlite.ExecuteNonQuery("INSERT INTO t (id, name) VALUES (2, 'b')");
        expect(sqlite.ExecuteNonQuery('DELETE FROM t')).toBe(2);
    });

    it('surfaces SQLite error text verbatim', () => {
        // handleSQLiteError in src/services/sqlite.js string-matches on these.
        expect(() => sqlite.Execute('SELECT * FROM missing_table')).toThrow(
            /no such table: missing_table/
        );
    });

    it('supports null args and no args', () => {
        expect(sqlite.Execute('SELECT 1', null)).toEqual([[1]]);
        expect(sqlite.Execute('SELECT 1')).toEqual([[1]]);
        expect(sqlite.Execute('SELECT 1', {})).toEqual([[1]]);
    });
});
