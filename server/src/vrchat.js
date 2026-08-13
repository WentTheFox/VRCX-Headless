/**
 * VRChat session: login, credential persistence and the pipeline connection.
 *
 * ## Phase 2a scaffold — read before extending
 *
 * The four auth endpoints below are driven through the WebApi shim *directly*
 * rather than through `src/services/request.js`, and the pipeline is connected
 * by `PipelineConnection` rather than by `src/services/websocket.js`.
 *
 * That is deliberate and temporary. `src/services/request.js:10` imports
 * `getCurrentUser` from `src/coordinators/userCoordinator.js`, and
 * `src/services/websocket.js` imports the stores barrel — either one drags in
 * the whole 629-file store/component closure, which does not load under Node
 * until the phase 2b aliases are in place. This file exists to prove the
 * WebApi + cookie contracts on their own.
 *
 * **Phase 2b deletes the request helpers and `PipelineConnection` here** and
 * switches to `src/api/auth.js`, `src/services/request.js` and
 * `src/services/websocket.js`. Do not grow this file in the meantime: anything
 * added here is divergence that phase 2b has to unpick. See CLAUDE.md §5.
 */
import { CookieStore } from './cookies.js';
import { log } from './log.js';
import { installWebApiGlobal, WebApiShim } from './shims/webapi.js';

/** Defaults from `src/services/appConfig.js:21-24`. */
export const DEFAULT_ENDPOINT = 'https://api.vrchat.cloud/api/1';
export const DEFAULT_WEBSOCKET = 'wss://pipeline.vrchat.cloud';

/**
 * Reproduces `GetVersion()` in Dotnet/Program.cs:67 — a 7-character trailing
 * segment marks a nightly build. VRChat rate-limits generic user agents, so
 * this is functional, not cosmetic.
 *
 * @param {string} version contents of the repo-root `Version` file
 * @returns {string}
 */
export function buildUserAgent(version) {
    const parts = String(version).trim().split('-');
    return parts.length > 0 && parts[parts.length - 1].length === 7
        ? `VRCX Nightly ${version}`
        : `VRCX ${version}`;
}

export class VRChatSession {
    /** @type {import('./db.js').DatabaseHandle} */
    #db;
    /** @type {CookieStore} */
    #cookies;
    /** @type {WebApiShim} */
    #webApi;
    #endpoint = DEFAULT_ENDPOINT;
    #websocket = DEFAULT_WEBSOCKET;
    #userAgent;

    /**
     * @param {import('./db.js').DatabaseHandle} db
     * @param {{ userAgent: string }} options
     */
    constructor(db, { userAgent }) {
        this.#db = db;
        this.#userAgent = userAgent;
        this.#cookies = new CookieStore().attach(db.sqlite).load();
        this.#webApi = installWebApiGlobal(
            new WebApiShim({ cookies: this.#cookies, userAgent })
        );
    }

    get userAgent() {
        return this.#userAgent;
    }

    get webApi() {
        return this.#webApi;
    }

    get cookies() {
        return this.#cookies;
    }

    get endpoint() {
        return this.#endpoint;
    }

    get websocketDomain() {
        return this.#websocket;
    }

    /**
     * @param {{ endpoint?: string, websocket?: string }} loginParams
     */
    useEndpoints(loginParams = {}) {
        this.#endpoint = loginParams.endpoint || DEFAULT_ENDPOINT;
        this.#websocket = loginParams.websocket || DEFAULT_WEBSOCKET;
    }

    /**
     * Minimal stand-in for `src/services/request.js` — see the file header.
     *
     * @param {string} endpoint e.g. 'auth/user'
     * @param {{ method?: string, headers?: Record<string,string>, params?: object }} [options]
     * @returns {Promise<any>} the parsed JSON body
     */
    async request(endpoint, options = {}) {
        const method = options.method ?? 'GET';
        let url = `${this.#endpoint}/${endpoint}`;
        /** @type {Record<string, any>} */
        const requestOptions = { url, method, headers: { ...options.headers } };

        if (options.params) {
            if (method === 'GET') {
                const query = new URLSearchParams(options.params).toString();
                requestOptions.url = query ? `${url}?${query}` : url;
            } else {
                requestOptions.headers['Content-Type'] =
                    'application/json;charset=utf-8';
                requestOptions.body = JSON.stringify(options.params);
            }
        }

        const { Item1: status, Item2: data } =
            await this.#webApi.Execute(requestOptions);

        if (status === -1) {
            throw new Error(`Request to ${endpoint} failed: ${data}`);
        }

        let json;
        try {
            json = data ? JSON.parse(data) : null;
        } catch {
            throw new Error(
                `Request to ${endpoint} returned a non-JSON body (status ${status})`
            );
        }

        if (json?.error) {
            const message = json.error.message ?? JSON.stringify(json.error);
            const error = new Error(
                `VRChat API error on ${endpoint}: ${message}`
            );
            error.status = json.error.status_code ?? status;
            error.endpoint = endpoint;
            throw error;
        }

        if (status >= 400) {
            const error = new Error(
                `VRChat API returned ${status} for ${endpoint}`
            );
            error.status = status;
            error.endpoint = endpoint;
            throw error;
        }

        return json;
    }

    /**
     * `GET config`. The desktop app calls this before login; it also seeds the
     * API's own cookies.
     */
    getConfig() {
        return this.request('config');
    }

    /**
     * @param {string} username
     * @param {string} password
     * @returns {Promise<any>} the `auth/user` payload, which may demand 2FA
     */
    login(username, password) {
        // Matches src/stores/auth.js:916.
        const basic = btoa(
            `${encodeURIComponent(username)}:${encodeURIComponent(password)}`
        );
        return this.request('auth/user', {
            headers: { Authorization: `Basic ${basic}` }
        });
    }

    /**
     * @param {'totp' | 'otp' | 'emailotp'} kind
     * @param {string} code
     */
    verifyTwoFactor(kind, code) {
        // src/stores/auth.js:845 formats recovery codes as XXXX-XXXX.
        const normalised =
            kind === 'otp' && code.length === 8 && !code.includes('-')
                ? `${code.slice(0, 4)}-${code.slice(4)}`
                : code;
        return this.request(`auth/twofactorauth/${kind}/verify`, {
            method: 'POST',
            params: { code: normalised }
        });
    }

    getCurrentUser() {
        return this.request('auth/user');
    }

    /**
     * @returns {Promise<string>} the pipeline auth token
     */
    async getPipelineToken() {
        const json = await this.request('auth');
        if (!json?.token) {
            throw new Error('auth endpoint did not return a pipeline token');
        }
        return json.token;
    }

    /**
     * Which 2FA method VRChat is asking for, if any.
     *
     * @param {any} json an `auth/user` payload
     * @returns {'emailotp' | 'totp' | null}
     */
    static twoFactorKind(json) {
        const required = json?.requiresTwoFactorAuth;
        if (!Array.isArray(required) || required.length === 0) {
            return null;
        }
        // src/stores/auth.js:950 prefers emailOtp when both are offered.
        return required.includes('emailOtp') ? 'emailotp' : 'totp';
    }

    // #region savedCredentials — the same config blob the desktop app uses

    /**
     * @returns {Promise<Record<string, any>>}
     */
    async readSavedCredentials() {
        const raw = await this.#db.configRepository.getString(
            'savedCredentials',
            ''
        );
        if (!raw) {
            return {};
        }
        try {
            return JSON.parse(raw);
        } catch {
            log.warn('savedCredentials is not valid JSON; ignoring it');
            return {};
        }
    }

    /**
     * Writes the entry in exactly the shape `src/stores/auth.js:475-501` uses,
     * so the desktop app can still read it.
     *
     * @param {any} user the `auth/user` payload
     * @param {{ username: string, password: string, endpoint?: string, websocket?: string }} loginParams
     */
    async saveCredentials(user, loginParams) {
        const saved = await this.readSavedCredentials();
        saved[user.id] = {
            user,
            loginParams: {
                username: loginParams.username,
                password: loginParams.password,
                endpoint: loginParams.endpoint ?? '',
                websocket: loginParams.websocket ?? ''
            },
            cookies: this.#webApi.GetCookies()
        };
        await this.#db.configRepository.setString(
            'savedCredentials',
            JSON.stringify(saved)
        );
        await this.#db.configRepository.setString('lastUserLoggedIn', user.id);
        this.#cookies.save();
    }

    /**
     * @returns {Promise<{ userId: string, entry: any } | null>}
     */
    async loadLastSession() {
        const userId = await this.#db.configRepository.getString(
            'lastUserLoggedIn',
            ''
        );
        if (!userId) {
            return null;
        }
        const saved = await this.readSavedCredentials();
        const entry = saved[userId];
        if (!entry) {
            return null;
        }
        this.useEndpoints(entry.loginParams ?? {});
        if (entry.cookies) {
            this.#webApi.SetCookies(entry.cookies);
        }
        return { userId, entry };
    }

    /**
     * Clears the session but keeps the saved credentials, matching
     * `runLogoutFlow` in src/coordinators/authCoordinator.js:21.
     */
    async logout() {
        this.#webApi.ClearCookies();
        await this.#db.configRepository.remove('lastUserLoggedIn');
    }

    // #endregion
}

/**
 * Minimal pipeline client — see the file header; phase 2b replaces this with
 * `src/services/websocket.js` and its `handlePipeline` switch.
 */
export class PipelineConnection {
    /** @type {WebSocket | null} */
    #socket = null;
    #closed = false;
    /** Fixed 5 s, matching `src/services/websocket.js:102`. No backoff there either. */
    #reconnectDelay = 5000;
    /** @type {VRChatSession} */
    #session;
    /** @type {{ onEvent?: (type: string, content: any) => void }} */
    #handlers;

    /**
     * @param {VRChatSession} session
     * @param {{ onEvent?: (type: string, content: any) => void }} [handlers]
     */
    constructor(session, handlers = {}) {
        this.#session = session;
        this.#handlers = handlers;
        this.stats = { connected: false, messageCount: 0, bytesReceived: 0 };
    }

    async connect() {
        const token = await this.#session.getPipelineToken();
        const url = `${this.#session.websocketDomain}/?auth=${token}`;
        // Cloudflare drops the handshake outright without a User-Agent, and
        // Node's WebSocket sends none by default (unlike a browser, which
        // always attaches its own). Same header WebApiShim sends over HTTP.
        const socket = new WebSocket(url, {
            headers: { 'User-Agent': this.#session.userAgent }
        });
        this.#socket = socket;

        socket.onopen = () => {
            this.stats.connected = true;
            log.info('Pipeline connected');
        };

        socket.onmessage = (event) => {
            const data = String(event.data);
            this.stats.messageCount += 1;
            this.stats.bytesReceived += data.length;
            try {
                const json = JSON.parse(data);
                // The pipeline double-encodes `content` as a JSON string.
                const content =
                    typeof json.content === 'string'
                        ? JSON.parse(json.content)
                        : json.content;
                log.debug(`Pipeline event: ${json.type}`);
                this.#handlers.onEvent?.(json.type, content);
            } catch (err) {
                log.warn(`Unparseable pipeline frame: ${err.message}`);
            }
        };

        socket.onerror = () => {
            log.warn('Pipeline socket error');
        };

        socket.onclose = () => {
            this.stats.connected = false;
            this.#socket = null;
            if (this.#closed) {
                return;
            }
            log.info(
                `Pipeline disconnected; reconnecting in ${this.#reconnectDelay / 1000}s`
            );
            setTimeout(() => {
                if (!this.#closed) {
                    this.connect().catch((err) =>
                        log.error(`Pipeline reconnect failed: ${err.message}`)
                    );
                }
            }, this.#reconnectDelay);
        };
    }

    close() {
        this.#closed = true;
        this.#socket?.close();
        this.#socket = null;
        this.stats.connected = false;
    }
}
