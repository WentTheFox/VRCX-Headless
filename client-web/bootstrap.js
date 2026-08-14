/**
 * The web client's real entry point (`client-web/index.html`'s
 * `<script type="module" src="./bootstrap.js">`) — deliberately separate
 * from `src/app.js` (the real, unmodified upstream entry) rather than an
 * edit to it or to `src/App.vue`. `src/app.js` top-level-awaits
 * `initPlugins()`/`initPiniaPlugins()` and creates the real Vue app the
 * moment it's imported — there is no hook inside it to gate on. So instead,
 * this file gates *whether `src/app.js` gets imported at all*: render a
 * minimal password form, and only `import('../src/app.js')` once
 * `/api/login` (phase 3) has set a valid session cookie. Everything the
 * real app needs (stores, `App.vue`, the router) stays completely
 * untouched.
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
import { AppDebug } from '../src/services/appConfig.js';

const root = document.getElementById('root');

AppDebug.websocketDomain = `${location.origin.replace(/^http/, 'ws')}/api/stream`;

/**
 * @param {string} [error]
 */
function renderLoginForm(error) {
    root.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100vh;';

    const form = document.createElement('form');
    form.style.cssText =
        'display:flex;flex-direction:column;gap:0.75rem;width:20rem;padding:2rem;border-radius:0.5rem;background:#25252b;';

    const title = document.createElement('h1');
    title.textContent = 'VRCX';
    title.style.cssText = 'margin:0 0 0.5rem;font-size:1.25rem;';

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Server password';
    input.autofocus = true;
    input.style.cssText =
        'padding:0.5rem;border-radius:0.25rem;border:1px solid #444;background:#1a1a1e;color:#eee;';

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Connect';
    button.style.cssText =
        'padding:0.5rem;border-radius:0.25rem;border:none;background:#4a4af0;color:#fff;cursor:pointer;';

    form.append(title, input, button);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = 'margin:0;color:#f87171;font-size:0.875rem;';
        form.append(errorText);
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        button.disabled = true;
        login(input.value)
            .then((ok) => {
                if (ok) {
                    startApp();
                } else {
                    renderLoginForm('Wrong password.');
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
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function login(password) {
    const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    return response.ok;
}

/**
 * A harmless RPC call: 401 means no session yet, anything else means the
 * existing session cookie (from a previous visit) is still valid, so the
 * login form can be skipped entirely.
 * @returns {Promise<boolean>}
 */
async function hasValidSession() {
    const response = await fetch('/api/rpc', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            target: 'config',
            method: 'getString',
            args: ['lastUserLoggedIn', '']
        })
    });
    return response.status !== 401;
}

function startApp() {
    import('../src/app.js');
}

hasValidSession().then((valid) => {
    if (valid) {
        startApp();
    } else {
        renderLoginForm();
    }
});
