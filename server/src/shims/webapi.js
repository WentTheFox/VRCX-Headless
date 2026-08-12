/**
 * Headless implementation of the `window.WebApi` contract.
 *
 * A behavioural port of Dotnet/WebApi.cs onto Node's global `fetch`.
 * `src/services/webapi.js` is the only consumer and is used unmodified.
 *
 * Because both `LINUX` and `WINDOWS` are false on the server (see globals.js),
 * `src/services/webapi.js` takes the **non-LINUX** branch:
 *
 *     const item = await WebApi.Execute(options);
 *     if (item.Item1 === -1) throw item.Item2;      // a bare STRING, not Error
 *     return { status: item.Item1, data: item.Item2 };
 *
 * So `Execute` returns a `{Item1, Item2}` tuple and never throws; transport
 * failures come back as `Item1 === -1` with the message in `Item2`. Throwing an
 * `Error` object instead would be swallowed: `$throw` in
 * `src/services/request.js` does `typeof error === 'string' ? error :
 * JSON.stringify(error)`, and an Error stringifies to `{}`.
 */
import { log } from '../log.js';

/** Matches Dotnet/WebApi.cs:86. */
const MAX_REDIRECTS = 20;

/**
 * Upload variants of the request. `Dotnet/WebApi.cs` builds multipart bodies
 * for these; no server-side call site reaches them yet, so they fail loudly
 * rather than silently doing the wrong thing.
 */
const UPLOAD_FLAGS = [
    'uploadImage',
    'uploadImageLegacy',
    'uploadImagePrint',
    'uploadFilePUT'
];

/**
 * @param {unknown} headers
 * @returns {Record<string, string>}
 */
function parseHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
        return {};
    }
    if (headers instanceof Map) {
        return Object.fromEntries(headers.entries());
    }
    return { ...headers };
}

export class WebApiShim {
    /** @type {import('../cookies.js').CookieStore} */
    #cookies;
    /** @type {string} */
    #userAgent;

    /**
     * @param {{ cookies: import('../cookies.js').CookieStore, userAgent: string }} options
     */
    constructor({ cookies, userAgent }) {
        this.#cookies = cookies;
        this.#userAgent = userAgent;
    }

    /**
     * @param {Record<string, any>} options
     * @returns {Promise<{ Item1: number, Item2: string }>}
     */
    async Execute(options) {
        try {
            const upload = UPLOAD_FLAGS.find((flag) => options?.[flag]);
            if (upload) {
                // Deliberate: better a clear error than a subtly wrong body.
                return {
                    Item1: -1,
                    Item2: `${upload} is not supported by the headless server yet`
                };
            }
            return await this.#send(options);
        } catch (err) {
            // Mirrors the catch-all at Dotnet/WebApi.cs:499.
            return { Item1: -1, Item2: err?.message ?? String(err) };
        }
    }

    /**
     * The Electron-path entry point. Unused while `LINUX` is false, but kept so
     * the contract is complete and flipping the flag cannot break the server.
     *
     * @param {string} requestJson
     * @returns {Promise<string>}
     */
    async ExecuteJson(requestJson) {
        const { Item1, Item2 } = await this.Execute(JSON.parse(requestJson));
        return JSON.stringify({ status: Item1, message: Item2 });
    }

    /**
     * @returns {string} base64 cookie blob, in Dotnet/WebApi.cs's format
     */
    GetCookies() {
        return this.#cookies.serialize();
    }

    /**
     * @param {string} blob
     */
    SetCookies(blob) {
        this.#cookies.deserialize(blob);
        this.#cookies.save();
    }

    ClearCookies() {
        this.#cookies.clear();
    }

    /**
     * @param {Record<string, any>} options
     * @returns {Promise<{ Item1: number, Item2: string }>}
     */
    async #send(options) {
        const method = String(options.method ?? 'GET').toUpperCase();
        const headers = parseHeaders(options.headers);

        /** @type {Record<string, string>} */
        const outgoing = { 'User-Agent': this.#userAgent };
        let contentType = null;
        for (const [key, value] of Object.entries(headers)) {
            if (value === undefined || value === null) {
                continue;
            }
            // Dotnet/WebApi.cs:445 — Content-Type belongs on the body, not the
            // request headers.
            if (key.toLowerCase() === 'content-type') {
                contentType = String(value);
                continue;
            }
            outgoing[key] = String(value);
        }

        let body;
        if (
            method !== 'GET' &&
            method !== 'HEAD' &&
            options.body !== undefined
        ) {
            body = String(options.body);
            outgoing['Content-Type'] =
                contentType ?? 'text/plain;charset=utf-8';
        }

        let url = String(options.url);
        let redirects = 0;

        for (;;) {
            const cookieHeader = this.#cookies.headerFor(url);
            const requestHeaders = { ...outgoing };
            if (cookieHeader) {
                requestHeaders.Cookie = cookieHeader;
            }

            const response = await fetch(url, {
                method,
                headers: requestHeaders,
                body,
                // Redirects are followed by hand so the cookie jar is applied on
                // every hop, which is what CookieContainer does natively.
                redirect: 'manual'
            });

            const setCookie = response.headers.getSetCookie?.() ?? [];
            if (setCookie.length > 0) {
                this.#cookies.store(setCookie, url);
                this.#cookies.save();
            }

            const location = response.headers.get('location');
            if (
                location &&
                response.status >= 300 &&
                response.status < 400 &&
                redirects < MAX_REDIRECTS
            ) {
                redirects += 1;
                url = new URL(location, url).href;
                log.debug(`Following redirect to ${url}`);
                continue;
            }

            return await this.#readBody(response);
        }
    }

    /**
     * @param {Response} response
     * @returns {Promise<{ Item1: number, Item2: string }>}
     */
    async #readBody(response) {
        const responseContentType = response.headers.get('content-type') ?? '';

        if (
            responseContentType.includes('image/') ||
            responseContentType.includes('application/octet-stream')
        ) {
            // Dotnet/WebApi.cs:468 hardcodes the `image/png` prefix regardless
            // of the real type. Callers depend on that exact shape.
            const buffer = Buffer.from(await response.arrayBuffer());
            return {
                Item1: response.status,
                Item2: `data:image/png;base64,${buffer.toString('base64')}`
            };
        }

        return { Item1: response.status, Item2: await response.text() };
    }
}

/**
 * Publish the shim as `window.WebApi`, where `src/services/webapi.js` looks.
 *
 * @param {WebApiShim} instance
 */
export function installWebApiGlobal(instance) {
    globalThis.WebApi = instance;
    return instance;
}
