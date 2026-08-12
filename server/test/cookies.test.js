/**
 * The cookie jar persists in Dotnet/WebApi.cs's exact on-disk format so the
 * same VRCX.sqlite3 stays readable by the desktop app. These tests pin that
 * format; if they fail after an upstream merge, check WebApi.cs first.
 */
import { describe, expect, it } from 'vitest';

import { CookieStore } from '../src/cookies.js';
import { SQLiteShim } from '../src/shims/sqlite.js';

/**
 * @param {string} blob
 * @returns {any[]}
 */
function decode(blob) {
    return JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
}

describe('CookieStore', () => {
    it('serialises to base64 of a System.Net.Cookie array', () => {
        const store = new CookieStore();
        store.store(
            ['auth=token123; Path=/; Domain=.vrchat.cloud; Secure; HttpOnly'],
            'https://api.vrchat.cloud/api/1/auth/user'
        );

        const decoded = decode(store.serialize());

        expect(decoded).toHaveLength(1);
        expect(decoded[0]).toMatchObject({
            Name: 'auth',
            Value: 'token123',
            Domain: '.vrchat.cloud',
            Path: '/',
            Secure: true,
            HttpOnly: true,
            Version: 0
        });
    });

    it('flattens expiry to DateTime.MaxValue so session cookies survive restarts', () => {
        // Dotnet/WebApi.cs:204 does this deliberately; without it, a restart
        // loses the login.
        const store = new CookieStore();
        store.store(['session=abc; Path=/'], 'https://api.vrchat.cloud/');

        expect(decode(store.serialize())[0].Expires).toBe(
            '9999-12-31T23:59:59.9999999'
        );
    });

    it('marks host-only cookies without a leading dot', () => {
        const store = new CookieStore();
        store.store(['a=1; Path=/'], 'https://api.vrchat.cloud/');
        expect(decode(store.serialize())[0].Domain).toBe('api.vrchat.cloud');
    });

    it('round-trips its own blob', () => {
        const source = new CookieStore();
        source.store(
            ['auth=token123; Path=/; Domain=.vrchat.cloud; Secure'],
            'https://api.vrchat.cloud/api/1'
        );
        const blob = source.serialize();

        const target = new CookieStore();
        target.deserialize(blob);

        expect(target.headerFor('https://api.vrchat.cloud/api/1')).toBe(
            'auth=token123'
        );
    });

    it('reads a blob produced by the .NET desktop app', () => {
        // Shape taken from System.Text.Json's serialisation of List<Cookie>.
        const dotnetBlob = Buffer.from(
            JSON.stringify([
                {
                    Comment: '',
                    CommentUri: null,
                    HttpOnly: true,
                    Discard: false,
                    Domain: '.vrchat.cloud',
                    Expired: false,
                    Expires: '9999-12-31T23:59:59.9999999',
                    Name: 'auth',
                    Path: '/',
                    Port: '',
                    Secure: true,
                    TimeStamp: '2026-01-01T00:00:00',
                    Value: 'from-dotnet',
                    Version: 0
                }
            ]),
            'utf8'
        ).toString('base64');

        const store = new CookieStore();
        store.deserialize(dotnetBlob);

        expect(store.headerFor('https://api.vrchat.cloud/api/1')).toBe(
            'auth=from-dotnet'
        );
    });

    it('survives a corrupt blob instead of refusing to start', () => {
        const store = new CookieStore();
        expect(() => store.deserialize('not base64 at all!!')).not.toThrow();
    });

    it('persists through the cookies table and reloads', () => {
        const sqlite = new SQLiteShim().open(':memory:');
        try {
            const store = new CookieStore().attach(sqlite);
            store.store(
                ['auth=persisted; Path=/; Domain=.vrchat.cloud'],
                'https://api.vrchat.cloud/'
            );
            store.save();

            // The `cookies` table is created by the C# side, not by the JS
            // migration layer, so the store has to create it itself.
            const rows = sqlite.Execute('SELECT `key`, `value` FROM `cookies`');
            expect(rows).toHaveLength(1);
            expect(rows[0][0]).toBe('default');

            const reloaded = new CookieStore().attach(sqlite).load();
            expect(reloaded.headerFor('https://api.vrchat.cloud/')).toBe(
                'auth=persisted'
            );
        } finally {
            sqlite.close();
        }
    });

    it('clearing empties the jar and the stored row', () => {
        const sqlite = new SQLiteShim().open(':memory:');
        try {
            const store = new CookieStore().attach(sqlite);
            store.store(['auth=gone; Path=/'], 'https://api.vrchat.cloud/');
            store.save();
            store.clear();

            expect(store.headerFor('https://api.vrchat.cloud/')).toBe('');
            expect(
                decode(
                    String(
                        sqlite.Execute('SELECT `value` FROM `cookies`')[0][0]
                    )
                )
            ).toEqual([]);
        } finally {
            sqlite.close();
        }
    });
});
