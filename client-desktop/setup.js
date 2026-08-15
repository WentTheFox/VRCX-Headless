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

/**
 * @param {string} url
 */
function appendChangeServerLink(form, url) {
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = `Change server (${url})`;
    link.style.cssText = LINK_STYLE;
    link.addEventListener('click', () => renderUrlForm(url));
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
    appendChangeServerLink(form, url);

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
    appendChangeServerLink(form, url);

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

window.vrcxDesktopAgent
    .getStoredServerUrl()
    .then((url) => renderUrlForm(url ?? undefined))
    .catch(() => renderUrlForm());
