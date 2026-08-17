/**
 * The web client's real entry point (`client-web/index.html`'s
 * `<script type="module" src="./bootstrap.js">`) — deliberately separate
 * from `src/app.js` (the real, unmodified upstream entry) rather than an
 * edit to it or to `src/App.vue`. `src/app.js` top-level-awaits
 * `initPlugins()`/`initPiniaPlugins()` and creates the real Vue app the
 * moment it's imported — there is no hook inside it to gate on. So instead,
 * this file gates *whether `src/app.js` gets imported at all*: render a
 * minimal TOTP form, and only `import('../src/app.js')` once `/api/login`
 * (phase 3) has set a valid session cookie. Everything the real app needs
 * (stores, `App.vue`, the router) stays completely untouched.
 *
 * Originally a static password form; replaced with a TOTP code (RFC 6238,
 * `server/src/totp.js`) at the user's request. `/api/totp/setup` doubles as
 * a "is this server already enrolled?" probe (its status code *is* the
 * answer — 200 means no, 403 means yes), so first-run enrollment (QR code +
 * confirm code, this file) and every later login (just a code) share the
 * same entry point without a separate "is this the first visit" flag
 * anywhere. Deliberately one-shot: once enrolled, the server refuses both
 * TOTP routes unconditionally (`server/src/http-server.js`), so this file
 * never has an opportunity to show the secret/QR again after the first
 * successful confirmation — rotating is `setup-totp`-CLI-only from then on.
 *
 * Also sets `AppDebug.websocketDomain` before that import, so
 * `src/services/websocket.js`'s unmodified `connectWebSocket()` — which
 * builds `new WebSocket(\`${AppDebug.websocketDomain}/?auth=${token}\`)` —
 * connects to this server's `/api/stream` relay (phase 3) instead of
 * VRChat's real pipeline directly. No WebSocket-constructor interception
 * needed here (unlike the server's `installWebSocketUserAgentPolyfill`):
 * `websocketDomain` is already a plain, mutable, upstream-provided override
 * knob, not a hardcoded literal. The `?auth=` token still gets appended
 * (from a real, RPC-proxied VRChat `/auth` call) and is harmless — the
 * server's upgrade handler only checks the path and the session cookie.
 */
import qrcode from 'qrcode-generator';

import { AppDebug } from '../src/services/appConfig.js';

const root = document.getElementById('root');

AppDebug.websocketDomain = `${location.origin.replace(/^http/, 'ws')}/api/stream`;

/**
 * `server/src/group-instance-relay.js`'s client-side counterpart: the
 * server ships a synthetic pipeline-shaped frame
 * (`type: 'vrcx-headless-group-instances'`) over the same `/api/stream`
 * connection so the Groups sidebar (`groupStore.groupInstances`) gets
 * populated here too — that state is normally computed only by
 * `src/stores/updateLoop.js`'s server-only loop and never reaches any
 * client otherwise. Tapping the `WebSocket` constructor, rather than
 * editing `src/services/websocket.js`, mirrors the server's own
 * `pipeline-relay.js` tap and is proven side-effect-free alongside that
 * file's own unmodified `.onmessage` handling (both listeners fire
 * independently on the same message).
 */
function installGroupInstanceRelayTap() {
    const NativeWebSocket = window.WebSocket;
    class TappedWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
            super(url, protocols);
            if (typeof url !== 'string' || !url.includes('/api/stream')) {
                return;
            }
            this.addEventListener('message', (event) => {
                let frame;
                try {
                    frame = JSON.parse(event.data);
                } catch {
                    return;
                }
                if (frame?.type !== 'vrcx-headless-group-instances') {
                    return;
                }
                let payload;
                try {
                    payload = JSON.parse(frame.content);
                } catch {
                    return;
                }
                import('../src/coordinators/groupCoordinator.js').then(
                    ({ handleGroupUserInstances }) => {
                        handleGroupUserInstances({ json: payload });
                    }
                );
            });
        }
    }
    window.WebSocket = TappedWebSocket;
}
installGroupInstanceRelayTap();

const FORM_STYLE =
    'display:flex;flex-direction:column;gap:0.75rem;width:22rem;padding:2rem;border-radius:0.5rem;background:#25252b;';
const TITLE_STYLE = 'margin:0 0 0.5rem;font-size:1.25rem;';
const BUTTON_STYLE =
    'padding:0.5rem;border-radius:0.25rem;border:none;background:#4a4af0;color:#fff;cursor:pointer;';
const ERROR_STYLE = 'margin:0;color:#f87171;font-size:0.875rem;';

/**
 * A 6-digit code input with the exact hints password managers (Bitwarden,
 * 1Password, …) key off of to recognize and autofill a TOTP field.
 * @returns {HTMLInputElement}
 */
function createCodeInput() {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'otp';
    input.placeholder = '6-digit code';
    input.autocomplete = 'one-time-code';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]*';
    input.maxLength = 6;
    input.autofocus = true;
    input.style.cssText =
        'padding:0.5rem;border-radius:0.25rem;border:1px solid #444;background:#1a1a1e;color:#eee;letter-spacing:0.2em;';
    return input;
}

/**
 * @param {string} [error]
 */
function renderLoginForm(error) {
    root.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100vh;';

    const form = document.createElement('form');
    form.style.cssText = FORM_STYLE;

    const title = document.createElement('h1');
    title.textContent = 'VRCX';
    title.style.cssText = TITLE_STYLE;

    const input = createCodeInput();

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Connect';
    button.style.cssText = BUTTON_STYLE;

    form.append(title, input, button);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = ERROR_STYLE;
        form.append(errorText);
    }

    form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        button.disabled = true;
        login(input.value)
            .then((ok) => {
                if (ok) {
                    startApp();
                } else {
                    renderLoginForm('Wrong code.');
                }
            })
            .catch((err) => {
                renderLoginForm(err.message ?? 'Could not reach the server.');
            });
    });

    wrapper.append(form);
    root.append(wrapper);
}

/**
 * First-run enrollment: a QR code for `uri` (any TOTP app — Bitwarden,
 * Google Authenticator, 1Password, Authy, …), the raw secret for manual
 * entry, and a confirm-code field proving it was actually scanned/entered
 * correctly before anything is persisted server-side.
 * @param {string} secret
 * @param {string} uri
 * @param {string} [error]
 */
function renderSetupForm(secret, uri, error) {
    root.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100vh;';

    const form = document.createElement('form');
    form.style.cssText = FORM_STYLE;

    const title = document.createElement('h1');
    title.textContent = 'Set up VRCX';
    title.style.cssText = TITLE_STYLE;

    const instructions = document.createElement('p');
    instructions.textContent =
        'Scan this with a 2FA app, then enter the current code to confirm.';
    instructions.style.cssText = 'margin:0;font-size:0.875rem;color:#bbb;';

    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const qrImage = document.createElement('img');
    qrImage.src = qr.createDataURL(6, 4);
    qrImage.alt = 'TOTP QR code';
    qrImage.style.cssText =
        'align-self:center;border-radius:0.25rem;background:#fff;padding:0.5rem;';

    const secretText = document.createElement('p');
    secretText.textContent = secret;
    secretText.style.cssText =
        'margin:0;font-size:0.75rem;color:#888;word-break:break-all;text-align:center;font-family:monospace;';

    const input = createCodeInput();

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Confirm';
    button.style.cssText = BUTTON_STYLE;

    form.append(title, instructions, qrImage, secretText, input, button);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = ERROR_STYLE;
        form.append(errorText);
    }

    form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        button.disabled = true;
        confirmSetup(secret, input.value)
            .then((ok) => {
                if (ok) {
                    startApp();
                } else {
                    renderSetupForm(secret, uri, "That code didn't match.");
                }
            })
            .catch((err) => {
                renderSetupForm(
                    secret,
                    uri,
                    err.message ?? 'Could not reach the server.'
                );
            });
    });

    wrapper.append(form);
    root.append(wrapper);
}

/**
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function login(code) {
    // /api/web/login, not /api/login: the cookie-only mirror never hands
    // the raw session token back in the response body — the whole point
    // of an HttpOnly cookie is defeated if the same response that sets it
    // also puts the value somewhere this very fetch() call's JS can read
    // it. See server/src/http-server.js's sendNewSession() doc comment.
    const response = await fetch('/api/web/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
    });
    return response.ok;
}

/**
 * @param {string} secret
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function confirmSetup(secret, code) {
    const response = await fetch('/api/web/totp/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, code })
    });
    return response.ok;
}

/**
 * `/api/totp/setup`'s status code doubles as "is this server already
 * enrolled?" — 200 means no (and hands back a fresh secret + QR URI to
 * enroll with), 403 means yes (nothing to do here but log in normally).
 * @returns {Promise<{ needed: true, secret: string, uri: string } | { needed: false }>}
 */
async function checkTotpSetupNeeded() {
    const response = await fetch('/api/totp/setup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    if (response.status === 403) {
        return { needed: false };
    }
    const body = await response.json();
    if (!response.ok || !body.ok) {
        throw new Error(body.error ?? 'Could not reach the server.');
    }
    return { needed: true, secret: body.secret, uri: body.uri };
}

/**
 * Rotates the existing session cookie (from a previous visit) into a fresh
 * one with a full new expiry (`server/src/http-server.js`'s
 * `/api/session/refresh`, `server/src/http-auth.js`'s `SESSION_TTL_MS`) —
 * reusing the request as both "is there still a valid session?" and "reset
 * its clock" rather than a separate read-only probe, so simply reopening
 * the tab within the window keeps sliding it forward instead of counting
 * down from the original login. 401 means no session yet (or it finally
 * expired), anything else means the login form can be skipped entirely.
 * The new cookie is set by the response's `Set-Cookie` header; nothing
 * here needs to touch the token itself.
 * @returns {Promise<boolean>}
 */
async function refreshSession() {
    // /api/web/session/refresh — see login()'s comment above. This is the
    // one both clients hit on every single launch, so it's the route
    // where never handing the token to browser JS matters most.
    const response = await fetch('/api/web/session/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    return response.status !== 401;
}

function startApp() {
    import('../src/app.js');
}

refreshSession().then((valid) => {
    if (valid) {
        startApp();
        return;
    }
    checkTotpSetupNeeded()
        .then((status) => {
            if (status.needed) {
                renderSetupForm(status.secret, status.uri);
            } else {
                renderLoginForm();
            }
        })
        .catch((err) => {
            renderLoginForm(err.message ?? 'Could not reach the server.');
        });
});
