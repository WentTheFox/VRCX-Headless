/**
 * Cookie jar with .NET-compatible persistence.
 *
 * `Dotnet/WebApi.cs` stores the whole jar as one row in the `cookies` table:
 *
 *     key   = 'default'
 *     value = base64( JSON.stringify( List<System.Net.Cookie> ) )
 *
 * with System.Text.Json's default (PascalCase) property names. Nothing in
 * `src/**` ever parses that blob — `src/stores/auth.js` only moves it between
 * `WebApi.GetCookies()` and the `savedCredentials` config entry — so the format
 * is ours to choose. We deliberately keep .NET's, so the same database file
 * stays usable by the desktop app while the split is in progress.
 *
 * Note the `cookies` table is created by the C# side, *not* by the JS migration
 * layer, so this module creates it too.
 */
import { Cookie, CookieJar } from 'tough-cookie';

import { log } from './log.js';

/**
 * .NET's `DateTime.MaxValue` as System.Text.Json renders it.
 *
 * `GetAllCookies()` (Dotnet/WebApi.cs:204) forces every cookie's expiry to this
 * before saving, so that session cookies survive a restart. Reproduce it or
 * logins do not persist.
 */
const DOTNET_MAX_DATE = '9999-12-31T23:59:59.9999999';

const COOKIE_ROW_KEY = 'default';

/**
 * @param {import('tough-cookie').Cookie} cookie
 * @returns {Record<string, unknown>} a System.Net.Cookie-shaped object
 */
function toDotNetCookie(cookie) {
    return {
        Comment: '',
        CommentUri: null,
        HttpOnly: Boolean(cookie.httpOnly),
        Discard: false,
        // .NET writes domain cookies with a leading dot; tough-cookie tracks the
        // same distinction in `hostOnly` instead.
        Domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
        Expired: false,
        Expires: DOTNET_MAX_DATE,
        Name: cookie.key,
        Path: cookie.path ?? '/',
        Port: '',
        Secure: Boolean(cookie.secure),
        TimeStamp: (cookie.creation ?? new Date()).toISOString(),
        Value: cookie.value,
        Version: 0
    };
}

/**
 * @param {Record<string, any>} entry a System.Net.Cookie-shaped object
 * @returns {{ cookie: Cookie, url: string } | null}
 */
function fromDotNetCookie(entry) {
    const name = entry.Name ?? entry.name;
    const value = entry.Value ?? entry.value;
    const rawDomain = entry.Domain ?? entry.domain ?? '';
    if (!name || !rawDomain) {
        return null;
    }

    const hostOnly = !rawDomain.startsWith('.');
    const domain = hostOnly ? rawDomain : rawDomain.slice(1);
    const path = entry.Path ?? entry.path ?? '/';
    const secure = Boolean(entry.Secure ?? entry.secure);

    const cookie = new Cookie({
        key: name,
        value: String(value ?? ''),
        domain,
        hostOnly,
        path,
        secure,
        httpOnly: Boolean(entry.HttpOnly ?? entry.httpOnly),
        // Session cookies were flattened to DateTime.MaxValue on save; keep them
        // non-expiring rather than trying to round-trip an unrepresentable date.
        expires: 'Infinity'
    });

    return { cookie, url: `${secure ? 'https' : 'http'}://${domain}${path}` };
}

export class CookieStore {
    /** @type {CookieJar} */
    #jar = new CookieJar();
    /** @type {import('./shims/sqlite.js').SQLiteShim | null} */
    #sqlite = null;
    #dirty = false;

    /**
     * @param {import('./shims/sqlite.js').SQLiteShim} sqlite
     */
    attach(sqlite) {
        this.#sqlite = sqlite;
        sqlite.ExecuteNonQuery(
            'CREATE TABLE IF NOT EXISTS `cookies` (`key` TEXT PRIMARY KEY, `value` TEXT)'
        );
        return this;
    }

    get jar() {
        return this.#jar;
    }

    get isDirty() {
        return this.#dirty;
    }

    markDirty() {
        this.#dirty = true;
    }

    /**
     * @param {string} url
     * @returns {string} value for the `Cookie` request header
     */
    headerFor(url) {
        return this.#jar.getCookieStringSync(url);
    }

    /**
     * @param {string[]} setCookieHeaders raw `Set-Cookie` values
     * @param {string} url the URL they came from
     */
    store(setCookieHeaders, url) {
        for (const header of setCookieHeaders) {
            try {
                this.#jar.setCookieSync(header, url, { ignoreError: true });
                this.#dirty = true;
            } catch (err) {
                log.debug('Ignoring unparseable Set-Cookie', err.message);
            }
        }
    }

    /**
     * The `WebApi.GetCookies()` contract: base64 of the .NET cookie array.
     *
     * @returns {string}
     */
    serialize() {
        // Matches WebApi.cs:242 — reading the blob marks the jar dirty so the
        // next save definitely writes, which is what persists a fresh login.
        this.#dirty = true;
        const cookies = this.#jar
            .serializeSync()
            .cookies.map((raw) => Cookie.fromJSON(raw))
            .filter((cookie) => cookie !== null && cookie !== undefined)
            .map((cookie) => toDotNetCookie(cookie));
        return Buffer.from(JSON.stringify(cookies), 'utf8').toString('base64');
    }

    /**
     * The `WebApi.SetCookies(blob)` contract. Adds to the existing jar rather
     * than replacing it, matching `CookieContainer.Add`.
     *
     * @param {string} blob base64 of the .NET cookie array
     */
    deserialize(blob) {
        if (!blob) {
            return;
        }
        try {
            const parsed = JSON.parse(
                Buffer.from(blob, 'base64').toString('utf8')
            );
            if (!Array.isArray(parsed)) {
                return;
            }
            for (const entry of parsed) {
                const converted = fromDotNetCookie(entry);
                if (converted) {
                    this.#jar.setCookieSync(converted.cookie, converted.url, {
                        ignoreError: true
                    });
                }
            }
            this.#dirty = true;
        } catch (err) {
            // WebApi.cs logs and continues here too; a corrupt blob must not
            // stop the process from starting.
            log.error(`Failed to set cookies: ${err.message}`);
        }
    }

    clear() {
        this.#jar = new CookieJar();
        this.#dirty = true;
        this.save();
    }

    /**
     * Loads the persisted jar. Mirrors WebApi.cs:150.
     */
    load() {
        if (!this.#sqlite) {
            return this;
        }
        try {
            const rows = this.#sqlite.Execute(
                'SELECT `value` FROM `cookies` WHERE `key` = @key',
                { '@key': COOKIE_ROW_KEY }
            );
            if (rows.length > 0 && rows[0][0]) {
                this.deserialize(String(rows[0][0]));
                this.#dirty = false;
            }
        } catch (err) {
            log.error(`Failed to load cookies: ${err.message}`);
        }
        return this;
    }

    /**
     * Persists the jar if anything changed. Mirrors WebApi.cs:213.
     */
    save() {
        if (!this.#sqlite || !this.#dirty) {
            return;
        }
        try {
            this.#sqlite.ExecuteNonQuery(
                'INSERT OR REPLACE INTO `cookies` (`key`, `value`) VALUES (@key, @value)',
                { '@key': COOKIE_ROW_KEY, '@value': this.serialize() }
            );
            this.#dirty = false;
        } catch (err) {
            log.error(`Failed to save cookies: ${err.message}`);
        }
    }
}
