/**
 * The desktop client's server-connection gate (phase 5) —
 * `client-desktop/setup.html`'s real entry, loaded by
 * `src-electron/main.js`'s `loadServerSetup()` whenever there's no already-
 * connected, still-valid server session. Same hand-rolled-DOM approach as
 * `client-web/bootstrap.js`'s login form (no dependency on `src/**`, no
 * Vite build needed beyond bundling this file itself), plus a server URL
 * step first — "always external" (decided with the user) means there's no
 * same-origin default to assume.
 *
 * Mirrors `client-web/bootstrap.js`'s TOTP flow exactly (same one-shot
 * enrollment design, same `checkTotpSetupNeeded` status-code convention),
 * just routed through `window.vrcxDesktopAgent` (main-process IPC) instead
 * of same-origin `fetch`, and with a Server URL field first since there's
 * no origin to assume.
 *
 * `qrcode` is a plain global here, not an ES import — this page has no
 * Vite build step (`client-desktop/setup.html`'s own comment explains why
 * a bundler-style bare specifier can't be used).
 */
/* global qrcode */

const root = document.getElementById('root');

const FORM_STYLE =
    'display:flex;flex-direction:column;gap:0.75rem;width:22rem;padding:2rem;border-radius:0.5rem;background:#25252b;';
const TITLE_STYLE = 'margin:0 0 0.5rem;font-size:1.25rem;';
const FIELD_STYLE =
    'padding:0.5rem;border-radius:0.25rem;border:1px solid #444;background:#1a1a1e;color:#eee;';
const BUTTON_STYLE =
    'padding:0.5rem;border-radius:0.25rem;border:none;background:#4a4af0;color:#fff;cursor:pointer;';
const ERROR_STYLE = 'margin:0;color:#f87171;font-size:0.875rem;';
const LINK_STYLE =
    'align-self:center;background:none;border:none;color:#8888ff;font-size:0.8125rem;cursor:pointer;padding:0;';
const SERVER_ITEM_STYLE =
    'display:flex;flex-direction:column;gap:0.125rem;padding:0.625rem 0.75rem;border-radius:0.25rem;border:1px solid #444;background:#1a1a1e;color:#eee;text-align:left;cursor:pointer;';

/**
 * "Change server" everywhere routes back through the picker (or the bare
 * URL form, if there's only ever been one server) instead of hardcoding a
 * single previous URL — with multiple stored servers, jumping straight back
 * to whichever one was just being set up isn't necessarily what "change"
 * means anymore.
 */
function appendChangeServerLink(form) {
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = 'Change server';
    link.style.cssText = LINK_STYLE;
    link.addEventListener('click', () => renderEntry());
    form.append(link);
}

/**
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
    input.style.cssText = `${FIELD_STYLE}letter-spacing:0.2em;`;
    return input;
}

/**
 * Appends the "trust a self-signed CA certificate" control used by both
 * `renderUrlForm` and `renderPicker` — a self-signed server cert that's
 * merely OS-trusted (e.g. imported into the Windows certificate store)
 * still fails here with a bare "fetch failed", because the connection
 * attempts run in Electron's main process (plain Node), whose `fetch`/`ws`
 * TLS stack only trusts its own bundled CA bundle, not the OS trust store.
 * Importing here writes the cert to disk via `vrcx-import-ca-cert`
 * (`src-electron/main.js`) and requires a restart to take effect — Node
 * only reads `NODE_EXTRA_CA_CERTS` once, at process bootstrap.
 * @param {HTMLElement} container
 */
function appendCaCertControl(container) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;flex-direction:column;gap:0.25rem;align-items:center;border-top:1px solid #444;padding-top:0.5rem;';

    const status = document.createElement('p');
    status.style.cssText = 'margin:0;font-size:0.75rem;color:#888;';

    const actionLink = document.createElement('button');
    actionLink.type = 'button';
    actionLink.style.cssText = LINK_STYLE;

    const errorText = document.createElement('p');
    errorText.style.cssText = ERROR_STYLE;
    errorText.hidden = true;

    function showError(message) {
        errorText.textContent = message;
        errorText.hidden = !message;
    }

    function refresh() {
        window.vrcxDesktopAgent.getCaCertStatus().then(({ imported }) => {
            status.textContent = imported
                ? 'Custom CA certificate trusted.'
                : 'Connecting to a self-signed HTTPS server?';
            actionLink.textContent = imported
                ? 'Remove certificate'
                : 'Import CA certificate…';
            actionLink.onclick = imported ? removeCert : importCert;
        });
    }

    function importCert() {
        showError('');
        window.vrcxDesktopAgent.importCaCert().then((result) => {
            if (!result.ok) {
                if (result.error) {
                    showError(result.error);
                }
                return;
            }
            status.textContent =
                'Certificate imported — restart to apply.';
            actionLink.textContent = 'Restart now';
            actionLink.onclick = () => window.electron.restartApp();
        });
    }

    function removeCert() {
        showError('');
        window.vrcxDesktopAgent.removeCaCert().then(() => {
            status.textContent = 'Certificate removed — restart to apply.';
            actionLink.textContent = 'Restart now';
            actionLink.onclick = () => window.electron.restartApp();
        });
    }

    wrapper.append(status, actionLink, errorText);
    container.append(wrapper);
    refresh();
}

/**
 * @param {string} [url]
 * @param {string} [error]
 */
function renderUrlForm(url, error) {
    root.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100vh;';

    const form = document.createElement('form');
    form.style.cssText = FORM_STYLE;

    const title = document.createElement('h1');
    title.textContent = 'VRCX';
    title.style.cssText = TITLE_STYLE;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'Server URL (e.g. http://192.168.1.5:9000)';
    urlInput.value = url ?? '';
    urlInput.autofocus = true;
    urlInput.style.cssText = FIELD_STYLE;

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Continue';
    button.style.cssText = BUTTON_STYLE;

    form.append(title, urlInput, button);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = ERROR_STYLE;
        form.append(errorText);
    }

    appendCaCertControl(form);

    form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        if (!urlInput.value) {
            renderUrlForm(urlInput.value, 'Server URL is required.');
            return;
        }
        button.disabled = true;
        window.vrcxDesktopAgent
            .checkTotpSetupNeeded(urlInput.value)
            .then((result) => {
                if (!result.ok) {
                    renderUrlForm(
                        urlInput.value,
                        result.error ?? 'Could not connect.'
                    );
                    return;
                }
                if (result.needed) {
                    renderSetupForm(urlInput.value, result.secret, result.uri);
                } else {
                    renderLoginForm(urlInput.value);
                }
            })
            .catch((err) => {
                renderUrlForm(
                    urlInput.value,
                    err.message ?? 'Could not connect.'
                );
            });
    });

    wrapper.append(form);
    root.append(wrapper);
}

/**
 * @param {string} url
 * @param {string} [error]
 */
function renderLoginForm(url, error) {
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
    appendChangeServerLink(form);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = ERROR_STYLE;
        form.append(errorText);
    }

    form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        button.disabled = true;
        window.vrcxDesktopAgent
            .connectToServer(url, input.value)
            .then((result) => {
                if (!result.ok) {
                    renderLoginForm(url, result.error ?? 'Wrong code.');
                }
                // On success the main process itself loads the real app —
                // nothing left to do here.
            })
            .catch((err) => {
                renderLoginForm(url, err.message ?? 'Could not connect.');
            });
    });

    wrapper.append(form);
    root.append(wrapper);
}

/**
 * First-run enrollment: a QR code for `uri`, the raw secret for manual
 * entry, and a confirm-code field proving it was actually scanned/entered
 * correctly before anything is persisted server-side. Same one-shot design
 * as `client-web/bootstrap.js`'s own setup form — once confirmed, the
 * server refuses both TOTP routes unconditionally, so this screen never
 * comes back after the first success.
 * @param {string} url
 * @param {string} secret
 * @param {string} uri
 * @param {string} [error]
 */
function renderSetupForm(url, secret, uri, error) {
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
    appendChangeServerLink(form);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = ERROR_STYLE;
        form.append(errorText);
    }

    form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        button.disabled = true;
        window.vrcxDesktopAgent
            .confirmTotpSetup(url, secret, input.value)
            .then((result) => {
                if (!result.ok) {
                    renderSetupForm(
                        url,
                        secret,
                        uri,
                        result.error ?? "That code didn't match."
                    );
                }
                // On success the main process itself loads the real app —
                // nothing left to do here.
            })
            .catch((err) => {
                renderSetupForm(
                    url,
                    secret,
                    uri,
                    err.message ?? 'Could not connect.'
                );
            });
    });

    wrapper.append(form);
    root.append(wrapper);
}

/**
 * Attempts an already-known server the same way `renderUrlForm`'s submit
 * handler does — reused so picking a saved entry and typing a brand-new URL
 * both land on the same TOTP-setup-or-login branch.
 * @param {string} url
 * @param {(error: string) => void} onError
 */
function attemptServer(url, onError) {
    window.vrcxDesktopAgent
        .checkTotpSetupNeeded(url)
        .then((result) => {
            if (!result.ok) {
                onError(result.error ?? 'Could not connect.');
                return;
            }
            if (result.needed) {
                renderSetupForm(url, result.secret, result.uri);
            } else {
                renderLoginForm(url);
            }
        })
        .catch((err) => {
            onError(err.message ?? 'Could not connect.');
        });
}

/**
 * Shown whenever at least one server is already known — lets a user with a
 * VPN-gated home server or a local-test/live split pick a saved entry
 * instead of retyping a URL that's already stored, and doubles as the
 * post-boot-failure screen: if the default server couldn't be reached at
 * launch, this is what `client-desktop/setup.js`'s own load-time check
 * lands on instead of a bare, already-known-to-be-failing URL field.
 * @param {{url: string, label: string, isDefault: boolean}[]} servers
 * @param {string} [error]
 */
function renderPicker(servers, error) {
    root.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100vh;';

    const container = document.createElement('div');
    container.style.cssText = FORM_STYLE;

    const title = document.createElement('h1');
    title.textContent = 'VRCX';
    title.style.cssText = TITLE_STYLE;
    container.append(title);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = ERROR_STYLE;
        container.append(errorText);
    }

    for (const server of servers) {
        const item = document.createElement('button');
        item.type = 'button';
        item.style.cssText = SERVER_ITEM_STYLE;

        const label = document.createElement('span');
        label.textContent = server.isDefault
            ? `${server.label} ★`
            : server.label;
        label.style.cssText = 'font-size:0.875rem;';

        const url = document.createElement('span');
        url.textContent = server.url;
        url.style.cssText = 'font-size:0.75rem;color:#888;';

        item.append(label, url);
        item.addEventListener('click', () => {
            item.disabled = true;
            attemptServer(server.url, (message) => {
                renderPicker(servers, message);
            });
        });
        container.append(item);
    }

    const addLink = document.createElement('button');
    addLink.type = 'button';
    addLink.textContent = '+ Add a different server';
    addLink.style.cssText = LINK_STYLE;
    addLink.addEventListener('click', () => renderUrlForm());
    container.append(addLink);

    appendCaCertControl(container);

    wrapper.append(container);
    root.append(wrapper);
}

/**
 * Entry point: a picker when at least one server is already known (whether
 * this is a normal relaunch or the default server just failed to reconnect
 * at boot), otherwise the bare URL form for a genuinely first-run install.
 */
function renderEntry() {
    window.vrcxDesktopAgent
        .listServers()
        .then((servers) => {
            if (servers.length > 0) {
                renderPicker(servers);
            } else {
                renderUrlForm();
            }
        })
        .catch(() => renderUrlForm());
}

renderEntry();
