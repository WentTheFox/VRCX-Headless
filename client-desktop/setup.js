/**
 * The desktop client's server-connection gate (phase 5) —
 * `client-desktop/setup.html`'s real entry, loaded by
 * `src-electron/main.js`'s `loadServerSetup()` whenever there's no already-
 * connected, still-valid server session. Same hand-rolled-DOM approach as
 * `client-web/bootstrap.js`'s login form (no dependency on `src/**`, no
 * Vite build needed), plus a server URL field — "always external" (decided
 * with the user) means there's no same-origin default to assume.
 *
 * `window.vrcxDesktopAgent.connectToServer` (exposed by
 * `src-electron/preload.js`) does the real work in the main process; on
 * success, `src-electron/main.js`'s own `vrcx-connect-server` IPC handler
 * loads the real app itself — this file only needs to handle the failure
 * case by re-rendering the form with an error.
 */
const root = document.getElementById('root');

/**
 * @param {string} [error]
 */
function renderSetupForm(error) {
    root.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100vh;';

    const form = document.createElement('form');
    form.style.cssText =
        'display:flex;flex-direction:column;gap:0.75rem;width:22rem;padding:2rem;border-radius:0.5rem;background:#25252b;';

    const title = document.createElement('h1');
    title.textContent = 'VRCX';
    title.style.cssText = 'margin:0 0 0.5rem;font-size:1.25rem;';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'Server URL (e.g. http://192.168.1.5:9000)';
    urlInput.autofocus = true;
    urlInput.style.cssText =
        'padding:0.5rem;border-radius:0.25rem;border:1px solid #444;background:#1a1a1e;color:#eee;';

    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.placeholder = 'Server password';
    passwordInput.style.cssText = urlInput.style.cssText;

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = 'Connect';
    button.style.cssText =
        'padding:0.5rem;border-radius:0.25rem;border:none;background:#4a4af0;color:#fff;cursor:pointer;';

    form.append(title, urlInput, passwordInput, button);

    if (error) {
        const errorText = document.createElement('p');
        errorText.textContent = error;
        errorText.style.cssText = 'margin:0;color:#f87171;font-size:0.875rem;';
        form.append(errorText);
    }

    form.addEventListener('submit', (submitEvent) => {
        submitEvent.preventDefault();
        if (!urlInput.value) {
            renderSetupForm('Server URL is required.');
            return;
        }
        button.disabled = true;
        window.vrcxDesktopAgent
            .connectToServer(urlInput.value, passwordInput.value)
            .then((result) => {
                if (!result.ok) {
                    renderSetupForm(result.error ?? 'Could not connect.');
                }
                // On success the main process itself loads the real app —
                // nothing left to do here.
            })
            .catch((err) => {
                renderSetupForm(err.message ?? 'Could not connect.');
            });
    });

    wrapper.append(form);
    root.append(wrapper);
}

renderSetupForm();
