require('hazardous');
const path = require('path');
const {
    BrowserWindow,
    ipcMain,
    app,
    clipboard,
    Tray,
    Menu,
    dialog,
    Notification: ElectronNotification,
    nativeImage
} = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const { WebSocket: WsClient } = require('ws');

//app.disableHardwareAcceleration();

/**
 * A user-imported CA certificate for a self-signed headless server (see the
 * `vrcx-import-ca-cert`/`vrcx-remove-ca-cert` IPC handlers below) — trusting
 * it requires `NODE_EXTRA_CA_CERTS`, which Node only reads once, at process
 * bootstrap, before any of this file's own code runs. Mutating
 * `process.env` later has no effect on an already-running process, so if the
 * file exists but this process wasn't started with the matching env var
 * (either a fresh normal launch after an import, or the very first launch
 * after one), self-relaunch once with it set before anything else in this
 * process touches the network.
 *
 * Found live (2026-08-28): the comment here used to claim "the relaunched
 * child inherits `process.env`, so this becomes a no-op on the next launch"
 * — it doesn't, at least not in this Electron/Linux combination. A bare
 * `app.relaunch()` with no `env` doesn't carry the `NODE_EXTRA_CA_CERTS`
 * mutation two lines above to the new process, so the relaunched child hits
 * this exact same check again, with the same result, forever — a fast,
 * silent, resource-churning relaunch loop with no window ever created to
 * show anything went wrong, reported as "the app appears on the taskbar
 * with no window then closes." Fixed by passing `env: process.env`
 * explicitly instead of assuming Electron forwards the current process's
 * (already-mutated, in-memory) environment on its own.
 * @type {string}
 */
const customCaCertPath = path.join(getVRCXPath(), 'custom-ca.pem');
if (fs.existsSync(customCaCertPath) && process.env.NODE_EXTRA_CA_CERTS !== customCaCertPath) {
    process.env.NODE_EXTRA_CA_CERTS = customCaCertPath;
    app.relaunch({ args: process.argv.slice(1), env: process.env });
    app.exit(0);
}

function dotnetSetup() {
    const bundledDotNetPath = path.join(process.resourcesPath, 'dotnet-runtime');
    if (fs.existsSync(bundledDotNetPath)) {
        // Include bundled .NET runtime
        process.env.DOTNET_ROOT = bundledDotNetPath;
        process.env.PATH = `${bundledDotNetPath}:${process.env.PATH}`;
    } else if (process.platform === 'darwin') {
        const dotnetPath = path.join('/usr/local/share/dotnet');
        const dotnetPathArm = path.join('/usr/local/share/dotnet/x64');
        if (fs.existsSync(dotnetPathArm)) {
            process.env.DOTNET_ROOT = dotnetPathArm;
            process.env.PATH = `${dotnetPathArm}:${process.env.PATH}`;
        } else if (fs.existsSync(dotnetPath)) {
            process.env.DOTNET_ROOT = dotnetPath;
            process.env.PATH = `${dotnetPath}:${process.env.PATH}`;
        }
    }

    if (!isDotNetInstalled()) {
        app.whenReady().then(() => {
            dialog.showErrorBox(
                'VRCX Headless Desktop',
                'Please install .NET 10.0 Runtime "dotnet-runtime-10.0" to run VRCX Headless Desktop.'
            );
            app.quit();
        });
    }
}
dotnetSetup();

const VRCX_URI_PREFIX = 'vrcx';
let isOverlayActive = false;
let appIsQuitting = false;
const rootDir = app.getAppPath();

/** @type {Electron.Tray} */
let tray = null;

/** @type {Electron.NativeImage | string} */
let trayIcon = null;

/** @type {Electron.NativeImage | string} */
let trayIconNotify = null;

// Get launch arguments
let appImagePath = process.env.APPIMAGE;
const args = process.argv.slice(1);
const noInstall = args.includes('--no-install');
const x11 = args.includes('--x11');
// `x11` above only ever gated tryRelaunchWithArgs()'s own auto-relaunch
// decision below — it never actually told Chromium to use X11, so the flag
// did nothing on a Wayland session where auto-detection picks the native
// Wayland backend anyway. Found live: on a real Wayland+Vulkan desktop, that
// backend fails ('--ozone-platform=wayland' is not compatible with Vulkan)
// and the window never becomes visible, even though the process, tray icon,
// and agent connection all come up fine — silent enough that only actually
// looking at the screen caught it. Must run before app.whenReady() (and
// before any GPU process spawns), same requirement as any other
// app.commandLine switch.
if (x11) {
    app.commandLine.appendSwitch('ozone-platform', 'x11');
}
const noDesktop = args.includes('--no-desktop');
const startup = args.includes('--startup');
const debug = args.includes('--hot-reload');
const noUpdater = args.includes('--no-updater') || fs.existsSync(path.join(rootDir, '.no-updater'));
// Set on the relaunch spawned by checkAndInstallForkUpdateInner()'s Linux
// branch (below) — lets installVRCX() know this launch is a direct
// continuation of an unattended background update, not a user
// double-clicking the AppImage, so it can skip its own "install to
// ~/Applications?" prompt for this one run. The fork-updater's whole design
// principle is "no confirmation click, ever" (CLAUDE.md §9) — a blocking
// dialog immediately after a silent update violates that regardless of how
// reasonable the question is on a genuine first run.
const postUpdate = args.includes('--post-update');
if (app.isPackaged && process.defaultApp && process.platform !== 'win32') {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(VRCX_URI_PREFIX, process.execPath, [path.resolve(process.argv[1])]);
    } else {
        app.setAsDefaultProtocolClient(VRCX_URI_PREFIX);
    }
}

const version = getVersion();
const homePath = getHomePath();
tryRelaunchWithArgs(args);
tryCopyFromWinePrefix();
const userDataPath = getElectronUserDataPath();
console.log('Electron userData path:', userDataPath);
if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
}
app.setPath('userData', userDataPath);

const armPath = path.join(rootDir, 'build/Electron/VRCX-Electron-arm64.cjs');
if (process.arch === 'arm64' && fs.existsSync(armPath)) {
    require(armPath);
} else {
    require(path.join(rootDir, 'build/Electron/VRCX-Electron.cjs'));
}

const InteropApi = require('./InteropApi');
const interopApi = new InteropApi();

const OVERLAY_WRIST_FRAME_WIDTH = 512;
const OVERLAY_WRIST_FRAME_HEIGHT = 512;
const OVERLAY_HMD_FRAME_WIDTH = 1024;
const OVERLAY_HMD_FRAME_HEIGHT = 1024;
const OVERLAY_SHARED_HEIGHT = OVERLAY_WRIST_FRAME_HEIGHT + OVERLAY_HMD_FRAME_HEIGHT;
const OVERLAY_SHARED_WIDTH = Math.max(OVERLAY_WRIST_FRAME_WIDTH, OVERLAY_HMD_FRAME_WIDTH);
const OVERLAY_FRAME_SIZE = OVERLAY_SHARED_WIDTH * OVERLAY_SHARED_HEIGHT * 4;
const OVERLAY_SHM_PATH = '/dev/shm/vrcx_overlay';
const overlayFrameBuffer = Buffer.alloc(OVERLAY_FRAME_SIZE + 1);
let activeNotification = null;

function createOverlayWindowShm() {
    fs.writeFileSync(OVERLAY_SHM_PATH, Buffer.alloc(OVERLAY_FRAME_SIZE + 1));
}

interopApi.getDotNetObject('ProgramElectron').PreInit(version, args);
interopApi.getDotNetObject('VRCXStorage').Load();
interopApi.getDotNetObject('ProgramElectron').Init();
// Phase 5: SQLite and WebApi are no longer initialized here at all. §1's
// ownership table says the .NET side stops opening VRCX.sqlite3 and
// talking to api.vrchat.cloud directly, entirely — both are server-owned
// now, exactly like the web client. VRCXStorage (above) is unaffected: it
// manages VRCX.json, genuinely machine-local config, a separate concern.
interopApi.getDotNetObject('AppApiElectron').Init();
interopApi.getDotNetObject('Discord').Init();
interopApi.getDotNetObject('LogWatcher').Init();

interopApi.getDotNetObject('SystemMonitorElectron').Init();
interopApi.getDotNetObject('AppApiVrElectron').Init();

ipcMain.handle('callDotNetMethod', (_event, className, methodName, args) => {
    return interopApi.callMethod(className, methodName, args);
});

// #region | Phase 5: headless server connection (agent channel + RPC relay)
//
// "Always external" (decided with the user): this process never spawns or
// embeds a server itself, it always connects to a `serve` instance running
// elsewhere. The renderer never talks to that server directly — a fetch
// from the renderer to a remote origin hits real browser CORS, which the
// server has deliberately never had to answer (phase 4's own design note).
// Routing everything through the main process instead sidesteps that
// entirely, using the exact same "renderer asks main, main does the real
// work" shape `callDotNetMethod` above already uses for native calls.

/** @type {string | null} */
let serverUrl = null;
/** @type {string | null} */
let serverToken = null;
/**
 * Every server this client has ever paired with, not just the active one —
 * `{url, token, label, isDefault}[]`, persisted as one JSON blob under
 * `VRCX_Servers`. `serverUrl`/`serverToken` above stay exactly what they
 * always were (the *active* connection's own cache, read by every existing
 * call site); this is the backing store `completeSession()` also upserts
 * into, and what the `vrcx-list-servers`/`vrcx-switch-server`/etc. IPC
 * handlers below operate on.
 * @type {{url: string, token: string, label: string, isDefault: boolean}[]}
 */
let servers = [];
/** @type {import('ws').WebSocket | null} */
let agentSocket = null;
/** @type {NodeJS.Timeout | null} */
let agentReconnectTimer = null;
/**
 * The relayed pipeline connection (`client-desktop/shims/pipeline-relay.js`)
 * — unlike `agentSocket`, this isn't kept alive by main.js itself; the
 * renderer's own `websocket.js` retry loop (unmodified) drives reconnects by
 * constructing a fresh relay `WebSocket` object, which calls
 * `vrcx-stream-connect` again. Only one at a time, same as the real pipeline
 * connection it replaces.
 * @type {import('ws').WebSocket | null}
 */
let streamSocket = null;
/** Updated opportunistically by every `vrcx-rpc` call and a periodic
 * health-check timer; pushed to the renderer on change (not every tick) so
 * the "Headless" status-bar indicator (`src/components/HeadlessServerStatus.vue`)
 * can reflect it without polling.
 * @type {boolean} */
let serverReachable = true;
/** @type {NodeJS.Timeout | null} */
let serverHealthCheckTimer = null;

/**
 * Node's `fetch` (undici) collapses every network-level failure — refused
 * connection, DNS failure, timeout, a broken TLS handshake — into the same
 * unhelpful top-level `Error: fetch failed`, with the actual reason nested
 * one level down in `err.cause` (a plain error, or an `AggregateError` with
 * `.errors` when DNS resolves to multiple addresses and all of them fail).
 * Found live (2026-08-23): a user pointing the setup screen at a port
 * nothing was listening on saw only "fetch failed", with no way to tell a
 * refused connection from a typo'd hostname or a firewalled port. Every
 * `fetchJson` caller already surfaces `err.message` straight to the user
 * (the setup screen, the "Headless" status panel's add-server form, etc.),
 * so unwrapping the cause once here — rather than in each of the ~8 call
 * sites — is what actually reaches them instead of a dead end.
 * @param {unknown} err
 * @returns {string}
 */
function describeFetchError(err) {
    if (!(err instanceof Error) || err.message !== 'fetch failed' || !err.cause) {
        return err instanceof Error ? err.message : String(err);
    }
    const cause = err.cause;
    const causes = Array.isArray(cause?.errors) ? cause.errors : [cause];
    const codes = new Set(causes.map((c) => c?.code).filter(Boolean));
    if (codes.has('ECONNREFUSED')) {
        return 'Connection refused — is a VRCX server actually running at that address and port?';
    }
    if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
        return 'Could not resolve that hostname — check the URL for typos.';
    }
    if (codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT')) {
        return 'Connection timed out — the address may be unreachable (wrong network or VPN?).';
    }
    if (codes.has('ECONNRESET')) {
        return 'Connection was reset by the server.';
    }
    if (
        codes.has('DEPTH_ZERO_SELF_SIGNED_CERT') ||
        codes.has('SELF_SIGNED_CERT_IN_CHAIN') ||
        codes.has('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    ) {
        return "The server's certificate is self-signed and not yet trusted here — import its CA certificate below.";
    }
    if (codes.has('CERT_HAS_EXPIRED')) {
        return "The server's TLS certificate has expired.";
    }
    const detail = causes
        .map((c) => c?.message)
        .filter(Boolean)
        .join('; ');
    return detail || err.message;
}

/**
 * @param {string} url
 * @param {import('node:https').RequestOptions & { body?: string }} options
 * @returns {Promise<{ status: number, body: any }>}
 */
async function fetchJson(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    } catch (err) {
        throw new Error(describeFetchError(err), { cause: err });
    }
    let body = null;
    try {
        body = await response.json();
    } catch {
        // A non-JSON or empty response (e.g. a proxy's own error page)
        // leaves body as null; callers treat that as "no usable body"
        // rather than throwing.
    }
    return { status: response.status, body };
}

/**
 * Opens the agent WebSocket to the currently configured server, answering
 * every forwarded `(className, methodName, args)` call with the *same*
 * `interopApi.callMethod` the renderer's own direct native calls already
 * use (`callDotNetMethod` above) — the agent channel is the server reaching
 * into this same capability, not a separate implementation of it.
 * Reconnects after 5s on close, mirroring `src/services/websocket.js`'s own
 * pipeline-reconnect interval, for as long as a server URL/token is set.
 */
/**
 * Pushes `vrcx-server-status-changed` to the renderer only when
 * `serverReachable` actually flips, not on every check — the "Headless"
 * status-bar indicator (`src/components/HeadlessServerStatus.vue`) listens
 * for this instead of polling.
 * @param {boolean} reachable
 */
function setServerReachable(reachable) {
    if (reachable === serverReachable) {
        return;
    }
    serverReachable = reachable;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vrcx-server-status-changed', {
            url: serverUrl,
            reachable: serverReachable
        });
    }
}

const HEALTH_CHECK_INTERVAL_MS = 20_000;

/**
 * A cheap authenticated ping on a flat interval, regardless of other RPC
 * traffic — simpler than tracking idle time between real requests, and
 * negligible cost. `vrcx-rpc` below also updates `serverReachable`
 * opportunistically on every real call, so this timer mostly matters
 * during idle periods (an open app with nothing happening) where nothing
 * else would otherwise notice a dropped connection for a while.
 */
function startServerHealthCheck() {
    stopServerHealthCheck();
    serverHealthCheckTimer = setInterval(async () => {
        if (!serverUrl || !serverToken) {
            return;
        }
        try {
            await fetchJson(`${serverUrl}/api/rpc`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverToken}`
                },
                body: JSON.stringify({
                    target: 'config',
                    method: 'getString',
                    args: ['lastUserLoggedIn', '']
                })
            });
            // Any real HTTP response (even a 401) means the server was
            // reachable — only a network-level failure below means it wasn't.
            setServerReachable(true);
        } catch {
            setServerReachable(false);
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}

function stopServerHealthCheck() {
    if (serverHealthCheckTimer) {
        clearInterval(serverHealthCheckTimer);
        serverHealthCheckTimer = null;
    }
}

function connectAgentSocket() {
    if (agentReconnectTimer) {
        clearTimeout(agentReconnectTimer);
        agentReconnectTimer = null;
    }
    if (agentSocket) {
        agentSocket.removeAllListeners();
        try {
            agentSocket.close();
        } catch {
            // already closed/closing
        }
        agentSocket = null;
    }
    if (!serverUrl || !serverToken) {
        return;
    }
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/api/agent`;
    const ws = new WsClient(wsUrl, {
        headers: { Authorization: `Bearer ${serverToken}` }
    });
    ws.on('open', () => console.log('Connected to server agent channel'));
    ws.on('message', async (data) => {
        /** @type {{ requestId?: unknown, className?: unknown, methodName?: unknown, args?: unknown }} */
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            return;
        }
        const { requestId, className, methodName, args } = message;
        if (typeof requestId !== 'string') {
            return;
        }
        try {
            const result = await interopApi.callMethod(className, methodName, Array.isArray(args) ? args : []);
            ws.send(JSON.stringify({ requestId, ok: true, result }));
        } catch (err) {
            ws.send(
                JSON.stringify({
                    requestId,
                    ok: false,
                    error: err?.message ?? String(err)
                })
            );
        }
    });
    ws.on('close', () => {
        if (agentSocket === ws) {
            agentSocket = null;
        }
        if (serverUrl && serverToken) {
            agentReconnectTimer = setTimeout(connectAgentSocket, 5000);
        }
    });
    ws.on('error', (err) => {
        console.error('Agent channel error:', err.message);
    });
    agentSocket = ws;
}

/**
 * `client-desktop/shims/pipeline-relay.js`'s counterpart: opens the real
 * `/api/stream` connection here (where the server token actually lives) and
 * forwards every frame to the renderer's relayed `WebSocket` object
 * verbatim, so `src/services/websocket.js`'s unmodified `handlePipeline`
 * still does all the real work. Found live (2026-08-17): without this, the
 * desktop renderer connected straight to VRChat's real pipeline instead —
 * a second connection racing the server's own already-open one for the same
 * account's `/auth` token, intermittently invalidating each other and
 * producing a real "authToken doesn't correspond with an active session"
 * pipeline error.
 */
ipcMain.on('vrcx-stream-connect', () => {
    if (streamSocket) {
        streamSocket.removeAllListeners();
        try {
            streamSocket.close();
        } catch {
            // already closed/closing
        }
        streamSocket = null;
    }
    if (!serverUrl || !serverToken) {
        return;
    }
    const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/api/stream`;
    const ws = new WsClient(wsUrl, {
        headers: { Authorization: `Bearer ${serverToken}` }
    });
    const send = (payload) => {
        if (streamSocket === ws && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('vrcx-stream-event', payload);
        }
    };
    ws.on('open', () => send({ type: 'open' }));
    ws.on('message', (data) => send({ type: 'message', data: data.toString() }));
    ws.on('close', (code, reason) => {
        send({ type: 'close', code, reason: reason?.toString() });
        if (streamSocket === ws) {
            streamSocket = null;
        }
    });
    ws.on('error', (err) => {
        console.error('Stream channel error:', err.message);
    });
    streamSocket = ws;
});

ipcMain.on('vrcx-stream-close', () => {
    if (streamSocket) {
        streamSocket.removeAllListeners();
        try {
            streamSocket.close();
        } catch {
            // already closed/closing
        }
        streamSocket = null;
    }
});

/**
 * Rotates the stored token into a fresh one with a full new expiry
 * (`server/src/http-server.js`'s `/api/session/refresh`,
 * `server/src/http-auth.js`'s `SESSION_TTL_MS`) instead of just probing
 * validity — every launch that still has a good token slides the "stay
 * logged in" window forward rather than counting down from the original
 * pairing. Same shape as `client-web/bootstrap.js`'s `refreshSession()`.
 * 401 (or any other failure) means the stored token is missing, expired,
 * or the server rejected it outright — falls through to the setup screen.
 * @returns {Promise<boolean>}
 */
async function refreshServerSession() {
    if (!serverUrl || !serverToken) {
        return false;
    }
    try {
        const { status: httpStatus, body } = await fetchJson(`${serverUrl}/api/session/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${serverToken}`
            },
            body: '{}'
        });
        if (httpStatus !== 200 || !body?.ok || !body.token) {
            return false;
        }
        completeSession(serverUrl, body.token);
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {string} url
 * @returns {string}
 */
function serverLabel(url) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * Reads `VRCX_Servers` into `servers`. Migrates the old flat
 * `VRCX_ServerUrl`/`VRCX_ServerToken` keys into a single-entry array (marked
 * default) if `VRCX_Servers` doesn't exist yet — the legacy keys are left
 * alone afterward rather than deleted, since removing them buys nothing and
 * a read-only migration should stay exactly that.
 */
function loadServers() {
    const raw = VRCXStorage.Get('VRCX_Servers');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                servers = parsed;
                return;
            }
        } catch {
            // Corrupt value — fall through to the legacy-key migration
            // below rather than crashing the whole app over a bad string.
        }
    }
    const legacyUrl = VRCXStorage.Get('VRCX_ServerUrl');
    const legacyToken = VRCXStorage.Get('VRCX_ServerToken');
    if (legacyUrl && legacyToken) {
        servers = [
            {
                url: legacyUrl,
                token: legacyToken,
                label: serverLabel(legacyUrl),
                isDefault: true
            }
        ];
        saveServers();
        return;
    }
    servers = [];
}

function saveServers() {
    VRCXStorage.Set('VRCX_Servers', JSON.stringify(servers));
    VRCXStorage.Save();
}

/**
 * @returns {{url: string, token: string, label: string, isDefault: boolean} | null}
 */
function getDefaultServer() {
    return servers.find((s) => s.isDefault) ?? servers[0] ?? null;
}

/**
 * Adds or updates a server entry and persists the whole list.
 * `completeSession()` calls this on every login/refresh, so `isDefault`
 * left `undefined` (not `false`) is what "don't touch the existing default
 * flag" means here — an ordinary token refresh must not silently un-default
 * whatever was already the default just because it happened to refresh
 * first. The very first server ever added still becomes default
 * automatically (`servers.length === 0` at insert time).
 * @param {string} url
 * @param {string} token
 * @param {{isDefault?: boolean}} [options]
 */
function upsertServer(url, token, { isDefault } = {}) {
    const existing = servers.find((s) => s.url === url);
    if (existing) {
        existing.token = token;
        if (isDefault !== undefined) {
            existing.isDefault = isDefault;
        }
    } else {
        servers.push({
            url,
            token,
            label: serverLabel(url),
            isDefault: isDefault ?? servers.length === 0
        });
    }
    if (isDefault) {
        for (const s of servers) {
            if (s.url !== url) {
                s.isDefault = false;
            }
        }
    }
    saveServers();
}

/**
 * Refuses to remove the currently-active server — the renderer's own UI is
 * expected to check `active` (from `vrcx-list-servers`) and disable that
 * row, this is the backstop. Best-effort `/api/logout` for the removed
 * entry's own token; failures are swallowed since the entry is being
 * deleted either way and there's no meaningful recovery action if the
 * server itself can't be reached to log out of.
 * @param {string} url
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function removeServer(url) {
    if (url === serverUrl) {
        return { ok: false, error: 'Switch away from this server first.' };
    }
    const target = servers.find((s) => s.url === url);
    if (!target) {
        return { ok: false, error: 'Unknown server.' };
    }
    try {
        await fetchJson(`${url}/api/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${target.token}`
            },
            body: '{}'
        });
    } catch {
        // Best-effort — see doc comment above.
    }
    const wasDefault = target.isDefault;
    servers = servers.filter((s) => s.url !== url);
    if (wasDefault && servers.length > 0) {
        servers[0].isDefault = true;
    }
    saveServers();
    return { ok: true };
}

/**
 * @param {string} url
 * @returns {boolean} whether a matching server was found
 */
function setDefaultServer(url) {
    let found = false;
    for (const s of servers) {
        s.isDefault = s.url === url;
        found ||= s.isDefault;
    }
    if (found) {
        saveServers();
    }
    return found;
}

/**
 * Shared by `connectToServer` and `confirmTotpSetup` — both end with "we
 * have a fresh session token for this server, remember it and open the
 * agent channel." Also the write path for `servers` (§ above) — every
 * successful login/refresh keeps that list's copy of this server's token
 * in sync, not just the active `serverUrl`/`serverToken` cache.
 * @param {string} normalizedUrl
 * @param {string} token
 */
function completeSession(normalizedUrl, token) {
    serverUrl = normalizedUrl;
    serverToken = token;
    upsertServer(normalizedUrl, token);
    connectAgentSocket();
    startServerHealthCheck();
}

/**
 * @param {string} url
 * @param {string} code the 6-digit TOTP code from the user's authenticator app
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function connectToServer(url, code) {
    const normalizedUrl = String(url).replace(/\/+$/, '');
    let response;
    try {
        response = await fetchJson(`${normalizedUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
    } catch (err) {
        return {
            ok: false,
            error: `Could not reach the server: ${err.message}`
        };
    }
    if (response.status !== 200 || !response.body?.ok || !response.body.token) {
        return {
            ok: false,
            error: response.body?.error ?? `Login failed (${response.status})`
        };
    }
    completeSession(normalizedUrl, response.body.token);
    return { ok: true };
}

/**
 * `/api/totp/setup`'s status code doubles as "is this server already
 * enrolled?" — same convention `client-web/bootstrap.js` relies on. 200
 * means no (hands back a fresh secret + QR URI), 403 means yes.
 * @param {string} url
 * @returns {Promise<{ needed: true, secret: string, uri: string } | { needed: false }>}
 */
async function checkTotpSetupNeeded(url) {
    const normalizedUrl = String(url).replace(/\/+$/, '');
    const response = await fetchJson(`${normalizedUrl}/api/totp/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    if (response.status === 403) {
        return { needed: false };
    }
    if (response.status !== 200 || !response.body?.ok) {
        throw new Error(response.body?.error ?? `Could not reach the server (${response.status})`);
    }
    return {
        needed: true,
        secret: response.body.secret,
        uri: response.body.uri
    };
}

/**
 * @param {string} url
 * @param {string} secret
 * @param {string} code
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function confirmTotpSetup(url, secret, code) {
    const normalizedUrl = String(url).replace(/\/+$/, '');
    let response;
    try {
        response = await fetchJson(`${normalizedUrl}/api/totp/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret, code })
        });
    } catch (err) {
        return {
            ok: false,
            error: `Could not reach the server: ${err.message}`
        };
    }
    if (response.status !== 200 || !response.body?.ok || !response.body.token) {
        return {
            ok: false,
            error: response.body?.error ?? `Confirm failed (${response.status})`
        };
    }
    completeSession(normalizedUrl, response.body.token);
    return { ok: true };
}

ipcMain.handle('vrcx-connect-server', async (_event, url, code) => {
    const result = await connectToServer(url, code);
    if (result.ok) {
        loadRealApp();
    }
    return result;
});

ipcMain.handle('vrcx-totp-setup', async (_event, url) => {
    try {
        return { ok: true, ...(await checkTotpSetupNeeded(url)) };
    } catch (err) {
        return { ok: false, error: err.message ?? String(err) };
    }
});

ipcMain.handle('vrcx-totp-confirm', async (_event, url, secret, code) => {
    const result = await confirmTotpSetup(url, secret, code);
    if (result.ok) {
        loadRealApp();
    }
    return result;
});

// #region | Multi-server: list/switch/remove/default, for
// src/components/HeadlessServerStatus.vue's post-auth server-switcher
// panel. Adding a *new* server reuses vrcx-connect-server/vrcx-totp-confirm
// above as-is — completeSession() already upserts into `servers`, and
// loadRealApp()'s fresh page load is exactly the "start clean" a
// newly-added server needs too, no separate handler required for that half.

ipcMain.handle('vrcx-list-servers', () =>
    servers.map(({ url, label, isDefault }) => ({
        url,
        label,
        isDefault,
        active: url === serverUrl
    }))
);

/**
 * Re-activates an already-paired server without asking for a fresh TOTP
 * code — the stored token from a previous pairing is used directly,
 * validated via the same `/api/session/refresh` call `refreshServerSession`
 * makes for the active connection, just scoped to a specific stored entry.
 * Switching also makes the target the new default: the natural reading of
 * "switch servers" is "this is what I want running", including on the next
 * launch — `vrcx-set-default-server` below is for the rarer case of
 * designating a future default without switching to it right now.
 */
ipcMain.handle('vrcx-switch-server', async (_event, url) => {
    const target = servers.find((s) => s.url === url);
    if (!target) {
        return { ok: false, error: 'Unknown server.' };
    }
    let response;
    try {
        response = await fetchJson(`${target.url}/api/session/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${target.token}`
            },
            body: '{}'
        });
    } catch (err) {
        return {
            ok: false,
            error: `Could not reach ${target.url}: ${err.message}`
        };
    }
    if (response.status !== 200 || !response.body?.ok || !response.body.token) {
        return {
            ok: false,
            error: 'The stored session for that server is no longer valid — remove it and pair again.'
        };
    }
    target.token = response.body.token;
    setDefaultServer(url);
    restartApp();
    return { ok: true };
});

ipcMain.handle('vrcx-remove-server', (_event, url) => removeServer(url));

ipcMain.handle('vrcx-set-default-server', (_event, url) => {
    const ok = setDefaultServer(url);
    return ok ? { ok: true } : { ok: false, error: 'Unknown server.' };
});

ipcMain.handle('vrcx-get-server-status', () => {
    const active = servers.find((s) => s.url === serverUrl);
    return {
        url: serverUrl,
        label: active?.label ?? (serverUrl ? serverLabel(serverUrl) : null),
        reachable: serverReachable
    };
});

// #endregion

ipcMain.handle('vrcx-rpc', async (_event, target, method, args) => {
    if (!serverUrl || !serverToken) {
        return { ok: false, error: 'Not connected to a server' };
    }
    try {
        const { status: httpStatus, body } = await fetchJson(`${serverUrl}/api/rpc`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${serverToken}`
            },
            body: JSON.stringify({ target, method, args })
        });
        // A real HTTP response — even a 401 — means the server itself was
        // reachable; only the network-level catch below means it wasn't.
        setServerReachable(true);
        if (httpStatus === 401) {
            return {
                ok: false,
                error: 'Not authenticated with the VRCX server'
            };
        }
        return body ?? { ok: false, error: `Unexpected response (${httpStatus})` };
    } catch (err) {
        setServerReachable(false);
        return { ok: false, error: err?.message ?? String(err) };
    }
});

// #endregion

/** @type {Electron.CrossProcessExports.BrowserWindow} */
let mainWindow = undefined;

const VRCXStorage = interopApi.getDotNetObject('VRCXStorage');
const hasAskedToMoveAppImage = VRCXStorage.Get('VRCX_HasAskedToMoveAppImage') === 'true';

function getCloseToTray() {
    if (process.platform === 'darwin') {
        return true;
    }
    return VRCXStorage.Get('VRCX_CloseToTray') === 'true';
}

const gotTheLock = app.requestSingleInstanceLock();
const strip_vrcx_prefix_regex = new RegExp('^' + VRCX_URI_PREFIX + '://');

if (!gotTheLock) {
    console.log('Another instance is already running. Exiting.');
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine, _workingDirectory) => {
        if (mainWindow && commandLine.length >= 2) {
            try {
                mainWindow.webContents.send(
                    'launch-command',
                    commandLine.pop().trim().replace(strip_vrcx_prefix_regex, '')
                );
            } catch (err) {
                console.error('Error processing second-instance command:', err);
            }
        }
    });

    app.on('open-url', (_event, url) => {
        if (mainWindow && url) {
            mainWindow.webContents.send('launch-command', url.replace(strip_vrcx_prefix_regex, ''));
        }
    });
}

ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

/**
 * Lets a user with a self-signed (but OS-trusted) headless server import its
 * CA certificate from the connection screen, instead of having to know about
 * `NODE_EXTRA_CA_CERTS` and set it in their shell/system environment
 * themselves — Node's `fetch`/`ws` TLS stack only trusts its own bundled CA
 * bundle, not the Windows/macOS/Linux trust store, so a cert that a browser
 * happily accepts still fails here (`describeFetchError` above turns it into
 * "self-signed and not yet trusted here" instead of a bare "fetch failed").
 * Takes effect
 * on the next app start (see the self-relaunch gate above `getVRCXPath()`'s
 * definition uses), which the caller is expected to trigger via the existing
 * `app:restart` handler.
 */
ipcMain.handle('vrcx-import-ca-cert', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
        return { ok: false };
    }
    let content;
    try {
        content = fs.readFileSync(result.filePaths[0], 'utf8');
    } catch (err) {
        return { ok: false, error: err.message };
    }
    if (!content.includes('BEGIN CERTIFICATE')) {
        return {
            ok: false,
            error: 'That file does not look like a PEM certificate.'
        };
    }
    fs.mkdirSync(path.dirname(customCaCertPath), { recursive: true });
    fs.writeFileSync(customCaCertPath, content, 'utf8');
    return { ok: true };
});

ipcMain.handle('vrcx-remove-ca-cert', () => {
    if (fs.existsSync(customCaCertPath)) {
        fs.unlinkSync(customCaCertPath);
    }
    return { ok: true };
});

ipcMain.handle('vrcx-get-ca-cert-status', () => {
    return { imported: fs.existsSync(customCaCertPath) };
});

/**
 * Relays `GET /api/update-check` (`server/src/update-check.js`) the same
 * way every other server-facing call here does — the renderer can't reach
 * the server directly (CORS), so main.js does the authenticated fetch and
 * hands back the JSON.
 */
ipcMain.handle('vrcx-check-update', async () => {
    if (!serverUrl || !serverToken) {
        return { ok: false };
    }
    try {
        const { status: httpStatus, body } = await fetchJson(`${serverUrl}/api/update-check`, {
            headers: { Authorization: `Bearer ${serverToken}` }
        });
        if (httpStatus !== 200 || !body?.ok) {
            return { ok: false };
        }
        return { ok: true, result: body.result };
    } catch {
        return { ok: false };
    }
});

ipcMain.handle('notification:showNotification', (_event, title, body, icon) => {
    if (activeNotification) {
        activeNotification.close();
    }

    const notification = new ElectronNotification({
        title,
        body,
        icon
    });
    notification.on('close', () => {
        if (activeNotification === notification) {
            notification.removeAllListeners();
            activeNotification = null;
        }
    });
    activeNotification = notification;
    notification.show();
});

/**
 * `app.exit()` is documented as immediate and synchronous, but found live
 * (2026-08-23): after `vrcx-switch-server` triggered a restart, the old
 * window and tray icon were left sitting there unresponsive and no new
 * window ever appeared — `app.relaunch()`'s own relauncher helper process
 * (visible in `ps` as `--type=relauncher`) blocks waiting for this
 * process's pid to actually die, and on this Linux session it never did.
 *
 * The first fix here was a `setTimeout(() => process.exit(code), 3000)` on
 * this same process's event loop — live-verified useless (2026-08-23,
 * second pass): over a minute passed with the process still alive and the
 * timer never fired. That makes sense in hindsight: if `app.exit()`'s
 * native shutdown path (GPU process teardown, tray/DBus cleanup) blocks
 * the main thread *synchronously* in C++, the single-threaded JS event
 * loop that would run the timer callback is blocked right along with it —
 * no amount of elapsed wall-clock time makes a timer fire on a thread
 * that never returns to libuv. A signal delivered by a genuinely separate
 * OS process has no such problem: `SIGKILL` is handled by the kernel and
 * terminates the target regardless of what it's doing, blocked native
 * call included. `detached: true` + `unref()` means this watchdog outlives
 * nothing if we exit cleanly first — it's a no-op in the overwhelming
 * common case, only ever actually killing anything when `app.exit()`
 * itself has failed to. No exit-code parameter: `SIGKILL` has no concept
 * of one, the process just stops.
 *
 * Live-verified working (2026-08-23, third pass, real hardware — a
 * sandboxed/CI-only repro couldn't have caught the previous two false
 * fixes, both of which only ever ran against a stale cached AppImage
 * extraction and were never actually exercised): the watchdog now spawns
 * immediately, the process dies ~3s later exactly on schedule, and the
 * waiting relauncher proceeds. One residual rough edge, not yet fully
 * chased down: on this same hardware, the relauncher's follow-up launch
 * has been observed to crash immediately (a native crash, no window)
 * often enough to be a real pattern rather than one-off noise — plausibly
 * some GPU/shared-memory/DBus resource the killed process held not being
 * released instantly enough for the new one to acquire cleanly. Net
 * effect either way is strictly better than before: the app is never
 * permanently and silently stuck again (the old process actually exits,
 * the tray icon actually goes away), worst case is "manually reopen it"
 * instead of "kill three processes by hand from a terminal."
 */
function scheduleForceExitFallback() {
    if (process.platform !== 'linux') {
        // The DBus/tray-teardown hang this works around (see this
        // function's own doc comment above) is Linux-specific, and the
        // watchdog itself spawns `sh`, which doesn't exist on Windows.
        // Found live (2026-08-24, Windows): the `before-quit` handler below
        // calls this unconditionally on every platform, unlike its other
        // two call sites (both already gated on `process.platform ===
        // 'linux'` at their own call site) — a plain restart on Windows
        // threw "spawn sh ENOENT" as an uncaught main-process exception
        // right after a successful update download. Guarding here, once,
        // makes every call site safe regardless of whether it remembers to
        // check the platform itself.
        return;
    }
    const pid = process.pid;
    const watchdog = spawn('sh', ['-c', `sleep 3; kill -9 ${pid} 2>/dev/null`], {
        detached: true,
        stdio: 'ignore'
    });
    watchdog.unref();
}

/**
 * Extracted so `vrcx-switch-server` (below) can trigger the exact same
 * clean relaunch the renderer's own "restart VRCX" action already uses —
 * switching servers needs every Pinia store to start fresh against the
 * new one rather than trying to hot-swap already-populated reactive
 * state, and a full relaunch is the simplest way to guarantee that.
 */
function restartApp() {
    if (process.platform === 'linux') {
        // Scheduled first, before anything else in this branch — found live
        // (2026-08-23, second pass): the watchdog spawned *after*
        // destroyTray() never actually appeared in the process tree at all,
        // meaning destroyTray() (this Linux session's tray icon talks to a
        // StatusNotifierItem over DBus, and DBus was already observed
        // flaking elsewhere in this same session) hung synchronously before
        // ever reaching the line that schedules the watchdog. Scheduling it
        // first means it exists no matter what hangs afterward — relaunch,
        // tray teardown, or exit itself.
        scheduleForceExitFallback();
        const options = {
            execPath: process.execPath,
            args: process.argv.slice(1)
        };
        if (appImagePath) {
            options.execPath = appImagePath;
        }
        app.relaunch(options);
        destroyTray();
        app.exit(0);
    } else {
        app.relaunch();
        app.quit();
    }
}

ipcMain.handle('app:restart', () => {
    restartApp();
});

ipcMain.handle('app:getOverlayWindow', () => {
    if (overlayWindow && overlayWindow.webContents) {
        return !overlayWindow.webContents.isLoading() && overlayWindow.webContents.isPainting();
    }
    return false;
});

ipcMain.handle('app:updateVr', (_event, active, hmdOverlay, wristOverlay, _menuButton, _overlayHand) => {
    if (!active || (!hmdOverlay && !wristOverlay)) {
        disposeOverlay();
        return;
    }
    if (active && !overlayWindow) {
        try {
            createOverlayWindowOffscreen();
        } catch (err) {
            console.error('Error creating overlay windows:', err);
        }
    }
});

ipcMain.handle('app:getArch', () => {
    return process.arch.toString();
});
ipcMain.handle('app:getClipboardText', () => {
    return clipboard.readText();
});

ipcMain.handle('app:getNoUpdater', () => {
    return noUpdater;
});

ipcMain.handle('app:setTrayIconNotification', (_event, notify) => {
    setTrayIconNotification(notify);
});

function tryRelaunchWithArgs(args) {
    if (process.platform !== 'linux' || x11 || args.includes('--ozone-platform-hint=auto')) {
        return;
    }

    const fullArgs = ['--ozone-platform-hint=auto', ...args];

    let execPath = process.execPath;

    if (appImagePath) {
        execPath = appImagePath;
        fullArgs.unshift('--appimage-extract-and-run');
    }

    console.log('Relaunching with args:', fullArgs);

    const child = spawn(execPath, fullArgs, {
        detached: true,
        stdio: 'inherit'
    });

    child.unref();

    scheduleForceExitFallback();
    destroyTray();
    app.exit(0);
}

let splashWindow = null;

/**
 * Fork addition: a minimal window shown only while `checkAndInstallForkUpdate()`
 * runs, before the real window/tray exist. Found live: without any visible
 * feedback, the extra few seconds a version check (and, when an update is
 * found, a real download) adds to startup looked exactly like the app
 * failing to open at all — nothing on screen, nothing in the taskbar to
 * reassure anyone it's doing something. No Vite build needed, same
 * reasoning as `client-desktop/setup.html`.
 */
function showSplash() {
    splashWindow = new BrowserWindow({
        width: 320,
        height: 180,
        frame: false,
        resizable: false,
        center: true,
        alwaysOnTop: true,
        backgroundColor: '#1a1a1e',
        icon: path.join(rootDir, 'images/VRCX.png'),
        webPreferences: {
            preload: path.join(__dirname, 'splash-preload.js')
        }
    });
    splashWindow.loadFile(path.join(rootDir, 'client-desktop/splash.html'));
}

/**
 * @param {string} text
 */
function updateSplashStatus(text) {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('splash-status', text);
    }
}

function closeSplash() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
    }
    splashWindow = null;
}

/**
 * Fork addition: the server-driven desktop updater's real entry point.
 * Runs once, at `app.whenReady()`, *before* `createWindow()` — before any
 * window exists, before `refreshServerSession()`/auth, before the real app
 * or even `client-desktop/setup.html` loads. Originally this lived entirely
 * post-auth in the renderer (`src/stores/vrcxUpdater.js`'s
 * `checkForForkUpdate`, triggered by `src/components/HeadlessServerStatus.vue`
 * on every server-reachable edge) — found live: that meant an update could
 * force-close and relaunch the whole app while someone was mid-session
 * actually using it. Moving the check here instead means the common cases
 * (a fresh launch, or a server switch — `vrcx-switch-server` below already
 * restarts the whole process, so it re-enters this same code path) never
 * show a loaded app before updating at all; the one case this no longer
 * catches is "the connected server was updated while I stayed open,
 * without ever restarting" — accepted as a gap rather than reintroducing
 * the mid-session interrupt. `checkForForkUpdate` stays in the renderer
 * store as a manual "Retry" action in Settings for exactly that gap.
 *
 * Talks to `GET /api/update-info` directly (`server/src/http-server.js`,
 * deliberately unauthenticated — see that route's own comment) rather than
 * the authenticated `/api/rpc` `update` target `client-desktop/shims/
 * update-service.js` uses, since there's no session (and, this early, not
 * even a renderer to hold `window.vrcxDesktopAgent`) to authenticate with
 * yet. Calls `AppApiElectron.DownloadUpdate` the same way
 * `interopApi.getDotNetObject('ProgramElectron')` is already called
 * directly from this file — no window/IPC round-trip needed for a native
 * call the main process can just make itself.
 */
/**
 * `console.log` goes nowhere visible in a packaged app (no attached
 * console) — found live (2026-08-24) after multiple silent failures in
 * `checkAndInstallForkUpdate()` left nothing to inspect afterward beyond
 * NLog's own `.NET`-side lines, which stop the moment control returns to
 * JS. Appends a timestamped line to `fork-update.log` (`getVRCXPath()`)
 * instead, mirroring `apply-update.log`'s own reasoning.
 * @param {string} text
 */
function logFork(text) {
    try {
        fs.appendFileSync(path.join(getVRCXPath(), 'fork-update.log'), `[${new Date().toISOString()}] ${text}\n`);
    } catch {
        // Best-effort diagnostic logging only.
    }
}

/**
 * `Dotnet/Update.cs`'s `DownloadUpdate` treats a missing/empty hash as
 * "skip the check" and downloads anyway — reasonable for upstream's own
 * permanently-dormant flow, not acceptable for something that installs
 * with no confirmation click. Rather than silently falling back to "no
 * hash" whenever `digest` isn't in the expected shape, this throws — GitHub
 * could in principle change its digest algorithm (or stop populating it) at
 * some point, and a silent fallback would then look *exactly* like
 * "nothing to update," forever, with no signal anything had changed. Same
 * helper (independently, since this is plain CommonJS with no shared
 * module boundary with the Vue store) as `src/stores/vrcxUpdater.js`'s own
 * `parseSha256Digest` — the thrown error surfaces through the existing
 * `catch` around `DownloadUpdate` below as a specific, readable
 * `logFork()` line instead of a silent skip.
 * @param {string | undefined} digest GitHub's `asset.digest`, expected `sha256:<64 lowercase hex chars>`
 * @param {string} assetName only used to make the thrown message useful
 * @returns {string} the bare hex hash
 */
function parseSha256Digest(digest, assetName) {
    const match = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? '');
    if (!match) {
        throw new Error(
            `Release asset ${assetName} has no verifiable sha256 digest (got ${JSON.stringify(digest ?? null)}) — GitHub's digest format may have changed`
        );
    }
    return match[1];
}

/**
 * Found live (2026-08-28): `update-release.js`'s `getUpdateInfo()` caches
 * its GitHub releases lookup server-side for 30 minutes (`CACHE_TTL_MS`) —
 * reasonable on its own, but combined with cutting several PATCH releases
 * in quick succession (this exact session), a client could connect to a
 * server whose cache was populated *between* two of those releases and get
 * confidently told the *older* one was the newest available. Reproduced
 * live: a client already on the newest release got "updated" backward to
 * the previous one purely from that timing — and since every release
 * before this fix carried the infinite-loop bug this same session already
 * found and fixed (comparing against `info.serverVersion` instead of
 * `info.release.tag`), landing back on an unfixed build reintroduced that
 * exact loop, from a client that had, until that moment, already been
 * running the fix. `targetVersion === installedVersion` alone doesn't
 * catch this — both are real version strings, just not the *same* one, and
 * nothing in the original comparison ever asked which one was newer.
 * Plain string comparison isn't safe here either once MINOR or PATCH
 * reaches double digits (`"24.10" < "24.9"` as strings, backwards from the
 * real numeric order) — this compares each dot-separated component as a
 * number instead.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if `a` is older than `b`, positive if newer, 0 if equal
 */
function compareForkVersions(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/**
 * @returns {Promise<boolean>} true when an update was applied and this
 *   process has already called `app.exit()` to relaunch — found live
 *   (2026-08-28, Linux): `app.exit()` does not actually halt execution of
 *   the calling `app.whenReady().then(async () => {...})` chain — it
 *   schedules the process teardown, but the `await
 *   checkAndInstallForkUpdate()` line's continuation still ran
 *   `createWindow()`/`createTray()`/`installVRCX()` before that teardown
 *   completed, spinning up a full GPU-accelerated window (and the exact
 *   Wayland/DBus teardown hang `scheduleForceExitFallback()` exists for)
 *   for a process that was already on its way out. The caller checks this
 *   return value and skips the rest of startup entirely when true.
 */
async function checkAndInstallForkUpdate() {
    try {
        return await checkAndInstallForkUpdateInner();
    } catch (err) {
        logFork(`Uncaught error: ${err?.stack ?? err?.message ?? err}`);
        return false;
    }
}

async function checkAndInstallForkUpdateInner() {
    logFork('checkAndInstallForkUpdate starting');
    loadServers();
    const defaultServer = getDefaultServer();
    if (!defaultServer?.url) {
        logFork('No default server configured, skipping');
        return false;
    }
    updateSplashStatus('Checking for updates…');
    let info;
    try {
        // A short, explicit timeout — this runs before any window exists,
        // so a hung network request here would hang the whole app's
        // startup, not just fail one check. 5s is generous for a same-
        // network health check but short enough that a genuinely
        // unreachable server doesn't noticeably delay opening the app.
        const { status, body } = await fetchJson(`${defaultServer.url}/api/update-info`, {
            signal: AbortSignal.timeout(5000)
        });
        if (status !== 200 || !body?.serverVersion) {
            logFork(`Unexpected /api/update-info response: status=${status} body=${JSON.stringify(body)}`);
            return false;
        }
        info = body;
    } catch (err) {
        logFork(`Fork update check failed: ${err?.message ?? err}`);
        return false;
    }
    const installedVersion = app.getVersion();
    logFork(
        `Installed version ${installedVersion}, server version ${info.serverVersion}, release ${info.release ? info.release.tag : 'none'}`
    );
    if (!info.release) {
        return false;
    }
    // Found live (2026-08-28): comparing against info.serverVersion here —
    // the *connected server's own* reported version — instead of
    // info.release.tag caused an infinite update loop the instant a client
    // was ever newer than the server it happened to be talking to. That's
    // not a rare edge case: CLAUDE.md's own MINOR/PATCH split means a
    // client-only PATCH release never requires the server to be redeployed,
    // so a real, otherwise-fine server can legitimately sit on an older
    // PATCH indefinitely. getUpdateInfo() already accounts for exactly
    // this — info.release is the newest PATCH under the server's own
    // MINOR, which can be ahead of what that server itself reports — but
    // this check compared against the server's version anyway, so it never
    // agreed the client (already on that same newest PATCH) was up to date:
    // every single launch re-downloaded and reinstalled the identical
    // already-installed build, forever. `vrcxUpdater.js`'s renderer-side
    // equivalent (`checkForForkUpdate`) already compares against
    // `info.release.tag` for this exact reason — this brings the two back
    // in sync instead of leaving this one path with the older, wrong logic.
    const targetVersion = info.release.tag.replace(/^v/, '');
    if (targetVersion === installedVersion) {
        return false;
    }
    if (compareForkVersions(targetVersion, installedVersion) < 0) {
        logFork(
            `Offered release ${targetVersion} is older than installed ${installedVersion} — likely a stale server-side release-list cache, refusing to downgrade`
        );
        return false;
    }
    // Suffix selection mirrors getForkAssetOfInterest's own doc comment in
    // src/stores/vrcxUpdater.js, the renderer-side equivalent of this same
    // asset-selection logic (duplicated rather than shared: that file is an
    // ESM module in the upstream-shared src/** store graph, this one is
    // plain CommonJS with no module-system bridge worth building for ten
    // lines of pure logic). `appImagePath` is only ever non-empty when this
    // process was actually launched from an AppImage (set from
    // `process.env.APPIMAGE` near the top of this file) — a dev/unpackaged
    // Linux run has nothing to self-update, same reasoning as
    // `installVRCX()`'s own `if (!appImagePath) return` guard.
    const isLinuxAppImage = process.platform === 'linux' && !!appImagePath;
    let suffix;
    if (process.platform === 'win32') {
        suffix = `win-${process.arch}.exe`;
    } else if (isLinuxAppImage) {
        suffix = `${process.arch}.AppImage`;
    } else {
        logFork(
            `Fork auto-update not supported here (platform=${process.platform}, appImagePath=${appImagePath || 'none'}), skipping`
        );
        return false;
    }
    const asset = info.release.assets?.find((a) => a.name?.endsWith(suffix));
    if (!asset) {
        logFork(`No asset matching suffix ${suffix} in release ${info.release.tag}`);
        return false;
    }
    logFork(`Fork update available: ${installedVersion} -> ${targetVersion}, downloading ${asset.name}`);
    if (isLinuxAppImage) {
        // Dotnet/Update.cs's DownloadUpdate branches on whether Update.Init
        // has been given an AppImage path — normally set by installVRCX()
        // below, but that hasn't run yet this early (checkAndInstallForkUpdate
        // is called before createWindow()/installVRCX() in app.whenReady()).
        // Without this, DownloadUpdate would silently take the Windows
        // branch and write a useless update.exe instead of swapping the
        // AppImage in place. Static state on the .NET side, so calling it
        // again from installVRCX() later is harmless.
        interopApi.getDotNetObject('Update').Init(appImagePath);
    }
    updateSplashStatus(`Downloading update ${targetVersion}…`);
    const appApi = interopApi.getDotNetObject('AppApiElectron');
    const progressTimer = setInterval(async () => {
        try {
            const progress = await appApi.CheckUpdateProgress();
            updateSplashStatus(`Downloading update ${targetVersion}… ${progress}%`);
        } catch {
            // Best-effort UI polish only — a failed progress read doesn't
            // affect the actual download awaited below.
        }
    }, 300);
    try {
        const hashString = parseSha256Digest(asset.digest, asset.name);
        await appApi.DownloadUpdate(asset.downloadUrl, hashString, asset.size);
    } catch (err) {
        logFork(`Fork update download failed: ${err?.message ?? err}`);
        return false;
    } finally {
        clearInterval(progressTimer);
    }
    logFork('Download + hash check complete');
    updateSplashStatus('Installing update…');
    if (isLinuxAppImage) {
        // Unlike Windows, there's no separate install step to schedule —
        // Update.DownloadUpdate's Linux branch already renamed the old
        // AppImage aside and moved the new download into place (plus
        // chmod +x) synchronously, before this await returned. All that's
        // left is relaunching.
        //
        // Found live (2026-08-28): the first version of this used
        // `app.relaunch({execPath: appImagePath}) + app.exit(0)`, the same
        // mechanism `restartApp()`'s Linux branch already uses for the
        // ordinary "restart VRCX" action. On a real run, `app.exit(0)`
        // turned out not to actually stop the calling `app.whenReady()`
        // chain in time — it went on to call `createWindow()` anyway (see
        // that call site's own comment), spinning up a real GPU-accelerated
        // window this early in startup hung on exit, and
        // `scheduleForceExitFallback()`'s watchdog had to SIGKILL the
        // process 3s later. `app.relaunch()`'s scheduled spawn only
        // actually happens as a side effect of Electron's *own* graceful
        // quit sequence completing — a raw SIGKILL bypasses that sequence
        // entirely, so the relaunch silently never fired: confirmed live by
        // the AppImage swap succeeding on disk but no new process ever
        // starting. Fixed two ways: the caller now skips `createWindow()`
        // entirely once this returns `true` (removing the thing that hung
        // in the first place), and the relaunch itself is spawned directly
        // here — detached, independent of how (or whether) this process's
        // own exit sequence completes — the same pattern
        // `tryRelaunchWithArgs()` above already uses for its own Wayland
        // relaunch. A bare detached spawn racing this process's own
        // teardown could still lose `requestSingleInstanceLock()` to the
        // still-alive parent, so the spawned shell sleeps first — longer
        // than `scheduleForceExitFallback()`'s own 3s kill delay, so the
        // parent is guaranteed dead (cleanly or via SIGKILL) before the
        // real relaunch attempt either way.
        //
        // Found live (2026-08-28, second pass): the relaunch args originally
        // carried only `--post-update`, on the assumption the fresh process
        // would sort out Wayland/ozone itself via its own
        // `tryRelaunchWithArgs()` call, same as a user double-clicking the
        // AppImage. It does — but that means a *second*, immediate
        // self-relaunch stacked right after this one's 5s-delayed relaunch,
        // visibly restarting the app twice for one update. Carrying the same
        // flags `tryRelaunchWithArgs()` itself would have added
        // (`--appimage-extract-and-run`, `--ozone-platform-hint=auto` unless
        // `x11`) collapses this back to a single relaunch, since the fresh
        // process's own `tryRelaunchWithArgs()` guard
        // (`args.includes('--ozone-platform-hint=auto')`) then already finds
        // itself relaunched.
        const relaunchDelaySeconds = 5;
        const relaunchArgs = ['--appimage-extract-and-run'];
        if (!x11) {
            relaunchArgs.push('--ozone-platform-hint=auto');
        }
        relaunchArgs.push('--post-update');
        const quoteForShell = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
        const relaunchCommand = [appImagePath, ...relaunchArgs].map(quoteForShell).join(' ');
        logFork(`Scheduling relaunch of ${appImagePath} in ${relaunchDelaySeconds}s (${relaunchArgs.join(' ')})`);
        const launcher = spawn('sh', ['-c', `sleep ${relaunchDelaySeconds}; exec ${relaunchCommand}`], {
            detached: true,
            stdio: 'ignore'
        });
        logFork(`Relaunch shell spawn returned, pid=${launcher.pid}`);
        launcher.on('error', (err) => logFork(`Relaunch shell spawn error: ${err?.message ?? err}`));
        launcher.unref();
        scheduleForceExitFallback();
        app.exit(0);
        return true;
    }
    // Found live (2026-08-24): letting `app.relaunch()` hand off to
    // Dotnet/Update.cs's Update.Check() (which installs the just-downloaded
    // update.exe at the top of the *next* ProgramElectron.Init(), then
    // relies on the NSIS one-click installer's own "run after finish" step
    // to bring the app back) doesn't reliably relaunch the app afterward.
    // First fix attempt — spawn the installer ourselves and await its own
    // 'exit' event before exiting — traded that bug for a different one,
    // found live immediately after: the installer's own "VRCX Headless is
    // running, press OK to close it" check raced our *own* teardown, since
    // we'd started it while our own process (spawned before `app.exit()`,
    // not after) hadn't necessarily finished dying yet — a blocking prompt,
    // not an auto-close, so "fully automatic" silently stalled on it.
    // Second fix attempt — hand the whole wait-then-install-then-relaunch
    // chain to a detached `cmd.exe` (`timeout /t 3 && "installer" &&
    // "app"`) so none of it runs from inside the exiting process — got
    // further (the installer visibly ran this time) but still never came
    // back, root-caused by inspecting `apply-update.log` (below) after the
    // fact: `&&` only proceeds on exit code 0, and this NSIS one-click
    // installer doesn't reliably return one even on a genuinely successful
    // install, so the chain silently stopped right before the relaunch
    // step, indistinguishable from the app just failing to reopen.
    //
    // Fixed by not gating on exit codes at all — a generated `.bat` (not
    // an inline `cmd /c` one-liner, both for readability and so `%errorlevel%`
    // has somewhere sane to land) runs the wait, the installer, and the
    // relaunch unconditionally in sequence, logging a timestamped line
    // after each step to `apply-update.log` in this same directory — so
    // if this *still* doesn't come back next time, the answer is a `type`
    // away instead of another guess-and-release cycle. `start "" "<app>"`
    // for the final step specifically so the batch script (and therefore
    // this whole detached process) doesn't sit there waiting for the
    // newly-relaunched app to exit before it's allowed to finish.
    const updateExePath = path.join(getVRCXPath(), 'update.exe');
    const execPathBeforeUpdate = process.execPath;
    const batchPath = path.join(getVRCXPath(), 'apply-update.bat');
    const logPath = path.join(getVRCXPath(), 'apply-update.log');
    const batchLines = [
        '@echo off',
        `echo [%date% %time%] scheduled, waiting for old process to exit > "${logPath}"`,
        'timeout /t 3 /nobreak >nul',
        `echo [%date% %time%] running installer >> "${logPath}"`,
        `"${updateExePath}"`,
        `echo [%date% %time%] installer exit code %errorlevel% >> "${logPath}"`,
        `start "" "${execPathBeforeUpdate}"`,
        `echo [%date% %time%] relaunch issued >> "${logPath}"`
    ];
    fs.writeFileSync(batchPath, batchLines.join('\r\n'));
    logFork(`Wrote ${batchPath}, spawning cmd.exe`);
    const launcher = spawn('cmd.exe', ['/c', batchPath], {
        detached: true,
        stdio: 'ignore'
    });
    logFork(`cmd.exe spawn returned, pid=${launcher.pid}`);
    // Fire-and-forget from here — an unhandled 'error' on this emitter
    // would otherwise crash the process we're about to exit anyway.
    launcher.on('error', (err) => logFork(`cmd.exe spawn error: ${err?.message ?? err}`));
    launcher.unref();
    logFork('Exiting now');
    app.exit(0);
    return true;
}

/**
 * Loads the real, unmodified upstream app — same debug/hot-reload branch as
 * before phase 5, just factored out so both the initial boot path and a
 * successful `vrcx-connect-server` call (from the setup screen) can reach
 * it.
 */
function loadRealApp() {
    const indexPath = path.join(rootDir, 'build/html/index.html');
    mainWindow.loadFile(indexPath);
    if (debug) {
        mainWindow.loadURL('http://localhost:9000/index.html');
        mainWindow.webContents.openDevTools();
    }
}

/**
 * `client-desktop/setup.html` needs no Vite build of its own — it's a
 * plain password-and-server-URL form with no dependency on `src/**`, same
 * reasoning as `client-web/bootstrap.js`'s login form being hand-rolled DOM
 * rather than a Vue component.
 */
function loadServerSetup() {
    mainWindow.loadFile(path.join(rootDir, 'client-desktop/setup.html'));
}

function createWindow() {
    console.log('Creating main window');

    if (mainWindow) {
        console.log('Main window already exists.');
    }

    app.commandLine.appendSwitch('enable-speech-dispatcher');

    const x = parseInt(VRCXStorage.Get('VRCX_LocationX')) || 0;
    const y = parseInt(VRCXStorage.Get('VRCX_LocationY')) || 0;
    const width = parseInt(VRCXStorage.Get('VRCX_SizeWidth')) || 1920;
    const height = parseInt(VRCXStorage.Get('VRCX_SizeHeight')) || 1080;
    const zoomLevel = parseFloat(VRCXStorage.Get('VRCX_ZoomLevel')) || 0;
    mainWindow = new BrowserWindow({
        x,
        y,
        width,
        height,
        icon: path.join(rootDir, 'images/VRCX.png'),
        autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset',
        title: 'VRCX Headless Desktop',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });
    // The real app's own build/html/index.html (upstream, untouched) still
    // titles itself plain "VRCX" — Electron otherwise follows the loaded
    // page's <title> on every navigation, which would silently revert the
    // distinguishing name above the moment the real app finishes loading.
    // Pinning it here, rather than editing that upstream file, keeps this
    // purely a fork-side concern.
    mainWindow.on('page-title-updated', (titleEvent) => titleEvent.preventDefault());
    applyWindowState();

    // Phase 5: gate on an already-connected, still-valid server session
    // before loading the real app at all — mirrors client-web/bootstrap.js's
    // own refreshSession() check. A stored token now survives a `serve`
    // restart on its own (server/src/http-auth.js's signed, stateless
    // tokens), and refreshServerSession() also slides its expiry forward on
    // every launch — so this only falls through to the setup screen once
    // the token is genuinely gone (never paired, explicitly logged out, or
    // finally aged out past SESSION_TTL_MS with no launch in between).
    // completeSession() (called inside refreshServerSession() on success)
    // already opens the agent socket, so there's nothing left to do here
    // beyond loading the real app.
    //
    // Reads the *default* entry from the multi-server list, not a flat
    // single-server key — loadServers() also handles migrating an older
    // install's VRCX_ServerUrl/VRCX_ServerToken into that list the first
    // time it runs.
    loadServers();
    const defaultServer = getDefaultServer();
    serverUrl = defaultServer?.url ?? null;
    serverToken = defaultServer?.token ?? null;
    refreshServerSession().then((connected) => {
        if (connected) {
            loadRealApp();
        } else {
            // The default server specifically failed — if there's at
            // least one *other* stored server, client-desktop/setup.js's
            // own multi-server picker (fed by vrcx-list-servers) surfaces
            // it immediately instead of only offering a bare URL field for
            // a server already known not to be working right now.
            loadServerSetup();
        }
    });

    // add proxy config, doesn't work, thanks electron
    // const proxy = VRCXStorage.Get('VRCX_Proxy');
    // if (proxy) {
    //     session.setProxy(
    //         { proxyRules: proxy.replaceAll('://', '=') },
    //         function () {
    //             mainWindow.loadFile(indexPath);
    //         }
    //     );
    //     session.setProxy({
    //         proxyRules: proxy.replaceAll('://', '=')
    //     });
    // }

    // Open the DevTools.
    // mainWindow.webContents.openDevTools()

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.setZoomLevel(zoomLevel);
    });

    mainWindow.webContents.on('before-input-event', (_event, input) => {
        if (input.control && input.key === '=') {
            mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 1);
        }
        if (input.control && input.key === '-') {
            mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 1);
        }
    });

    mainWindow.webContents.on('zoom-changed', (_event, zoomDirection) => {
        let currentZoom = mainWindow.webContents.getZoomLevel();
        if (zoomDirection === 'in') {
            mainWindow.webContents.setZoomLevel(++currentZoom);
        } else {
            mainWindow.webContents.setZoomLevel(--currentZoom);
        }
        VRCXStorage.Set('VRCX_ZoomLevel', currentZoom.toString());
    });
    mainWindow.webContents.setVisualZoomLevelLimits(1, 5);

    mainWindow.on('close', (closeEvent) => {
        //console.log("mainWindow.on('close')");

        if (getCloseToTray() && !appIsQuitting) {
            closeEvent.preventDefault();
            mainWindow.hide();
        } else {
            app.quit();
        }
    });

    mainWindow.on('resize', () => {
        const [width, height] = mainWindow.getSize().map((size) => size.toString());
        mainWindow.webContents.send('setWindowSize', { width, height });
    });

    mainWindow.on('move', () => {
        const [x, y] = mainWindow.getPosition().map((coord) => coord.toString());
        mainWindow.webContents.send('setWindowPosition', { x, y });
    });

    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('setWindowState', '2');
    });

    mainWindow.on('minimize', () => {
        mainWindow.webContents.send('setWindowState', '1');
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('setWindowState', '0');
    });

    mainWindow.on('restore', () => {
        mainWindow.webContents.send('setWindowState', '0');
    });

    mainWindow.on('focus', () => {
        mainWindow.webContents.send('onBrowserFocus');
    });
}

let overlayWindow = undefined;

function createOverlayWindowOffscreen() {
    if (process.platform !== 'linux') {
        console.error('Offscreen overlay is only supported on Linux.');
        return;
    }
    isOverlayActive = true;
    if (!fs.existsSync(OVERLAY_SHM_PATH)) {
        createOverlayWindowShm();
    }

    const x = parseInt(VRCXStorage.Get('VRCX_LocationX')) || 0;
    const y = parseInt(VRCXStorage.Get('VRCX_LocationY')) || 0;
    const width = OVERLAY_SHARED_WIDTH;
    const height = OVERLAY_SHARED_HEIGHT;

    overlayWindow = new BrowserWindow({
        x,
        y,
        width,
        height,
        icon: path.join(rootDir, 'images/VRCX.png'),
        autoHideMenuBar: true,
        transparent: true,
        frame: false,
        show: false,
        webPreferences: {
            partition: 'vrcx-vr-overlay',
            offscreen: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    overlayWindow.webContents.setFrameRate(48);

    let fileUrl = `file://${path.join(rootDir, 'build/html/vr.html')}`;
    if (debug) {
        fileUrl = 'http://localhost:9000/vr.html';
    }
    overlayWindow.loadURL(fileUrl, { userAgent: version });
    // Use paint event for offscreen rendering
    overlayWindow.webContents.on('paint', (_event, _dirty, image) => {
        const buffer = image.toBitmap();
        //console.log('Captured frame via paint event, size:', buffer.length);
        writeOverlayFrame(buffer);
    });
}

function writeOverlayFrame(imageBuffer) {
    let fd;
    try {
        fd = fs.openSync(OVERLAY_SHM_PATH, 'r+');
        overlayFrameBuffer[0] = 0; // not ready
        imageBuffer.copy(overlayFrameBuffer, 1, 0, OVERLAY_FRAME_SIZE);
        overlayFrameBuffer[0] = 1; // ready
        fs.writeSync(fd, overlayFrameBuffer);
        //console.log('Wrote frame to shared memory');
    } catch (err) {
        console.error('Error writing frame to shared memory:', err);
    } finally {
        if (typeof fd === 'number') {
            fs.closeSync(fd);
        }
    }
}

function destroyTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}

function createTray() {
    if (process.platform === 'darwin') {
        const image = nativeImage.createFromPath(path.join(rootDir, 'images/VRCX.png'));
        trayIcon = image.resize({ width: 16, height: 16 });

        const imageNotify = nativeImage.createFromPath(path.join(rootDir, 'images/VRCX_notify.png'));
        trayIconNotify = imageNotify.resize({ width: 16, height: 16 });
    } else if (process.platform === 'linux') {
        const image = nativeImage.createFromPath(path.join(rootDir, 'images/VRCX.png'));
        trayIcon = image.resize({ width: 64, height: 64 });

        const imageNotify = nativeImage.createFromPath(path.join(rootDir, 'images/VRCX_notify.png'));
        trayIconNotify = imageNotify.resize({ width: 64, height: 64 });
    } else {
        trayIcon = path.join(rootDir, 'images/VRCX.ico');
        trayIconNotify = path.join(rootDir, 'images/VRCX_notify.ico');
    }
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open',
            type: 'normal',
            click: function () {
                mainWindow.show();
            }
        },
        {
            label: 'DevTools',
            type: 'normal',
            click: function () {
                mainWindow.webContents.openDevTools();
            }
        },
        {
            label: 'Quit VRCX Headless Desktop',
            type: 'normal',
            click: function () {
                appIsQuitting = true;
                app.quit();
            }
        }
    ]);
    tray.setToolTip('VRCX Headless Desktop');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow.show();
    });
}

/**
 *
 * @param {Boolean} notify
 */
function setTrayIconNotification(notify) {
    if (tray) {
        tray.setImage(notify ? trayIconNotify : trayIcon);
    }
}

async function installVRCX() {
    console.log('Home path:', homePath);
    console.log('AppImage path:', appImagePath);
    if (!appImagePath) {
        console.error('AppImage path is not available!');
        return;
    }
    if (noInstall) {
        interopApi.getDotNetObject('Update').Init(appImagePath);
        console.log('Skipping installation.');
        return;
    }

    // Rename to this fork's own AppImage filename — deliberately not plain
    // "VRCX.AppImage" (upstream's own convention here, otherwise
    // unmodified): that's the exact filename the real desktop app installs
    // to, so a machine with both installed would have each one silently
    // overwrite the other's copy in ~/Applications on every launch.
    const currentName = path.basename(appImagePath);
    const expectedName = 'VRCX-Headless.AppImage';
    if (currentName !== expectedName) {
        const newPath = path.join(path.dirname(appImagePath), expectedName);
        try {
            // remove existing VRCX-Headless.AppImage
            if (fs.existsSync(newPath)) {
                fs.unlinkSync(newPath);
            }
            fs.renameSync(appImagePath, newPath);
            console.log('AppImage renamed to:', newPath);
            appImagePath = newPath;
        } catch (err) {
            console.error(`Error renaming AppImage ${newPath}`, err);
            dialog.showErrorBox('VRCX Headless Desktop', `Failed to rename AppImage ${newPath}`);
            return;
        }
    }

    // ask to move AppImage to ~/Applications — skipped for a post-update
    // relaunch (see `postUpdate`'s own definition near the top of this
    // file): the fork-updater's whole point is zero interaction, and this
    // question is only meaningful on a genuine first run anyway, not a
    // relaunch of an AppImage that was already sitting wherever it was.
    // Not persisted to VRCXStorage — a later ordinary (non-post-update)
    // launch still asks, same as before this existed.
    const appImageHomePath = `${homePath}/Applications/${expectedName}`;
    if (!hasAskedToMoveAppImage && !postUpdate && appImagePath !== appImageHomePath) {
        const result = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            title: 'VRCX Headless Desktop',
            message: 'Do you want to install VRCX Headless Desktop?',
            detail: 'VRCX Headless Desktop will be moved to your ~/Applications folder.',
            buttons: ['No', 'Yes']
        });
        if (result === 0) {
            console.log('Cancel AppImage move to ~/Applications');
            // don't ask again
            VRCXStorage.Set('VRCX_HasAskedToMoveAppImage', 'true');
            VRCXStorage.Save();
        }
        if (result === 1) {
            console.log('Moving AppImage to ~/Applications');
            try {
                const applicationsPath = path.join(homePath, 'Applications');
                // create ~/Applications if it doesn't exist
                if (!fs.existsSync(applicationsPath)) {
                    fs.mkdirSync(applicationsPath);
                }
                // remove existing VRCX-Headless.AppImage
                if (fs.existsSync(appImageHomePath)) {
                    fs.unlinkSync(appImageHomePath);
                }
                fs.renameSync(appImagePath, appImageHomePath);
                appImagePath = appImageHomePath;
                console.log('AppImage moved to:', appImageHomePath);
                await updateDesktopFile();
            } catch (err) {
                console.error(`Error moving AppImage ${appImageHomePath}`, err);
                dialog.showErrorBox('VRCX Headless Desktop', `Failed to move AppImage ${appImageHomePath}`);
                return;
            }
        }
    }

    // inform .NET side about AppImage path
    interopApi.getDotNetObject('Update').Init(appImagePath);
}

/**
 * Create or update this fork's desktop file.
 *
 * If the --no-desktop flag is set this function does nothing.
 * If there is an existing .desktop file, it will be updated with the current AppImage path.
 * If there is no .desktop file, the one inside the current AppImage will be copied to applications dir and
 * updated to the path of the AppImage.
 *
 * Found live (2026-08-23): this used to read and write `VRCX.desktop` —
 * the exact filename the real upstream desktop app installs to. Two
 * bugs from that one filename: (1) it never actually matched anything
 * real, since electron-builder's own `desktopName` (package.json) names
 * the file bundled *inside* this fork's own AppImage `VRCX-Headless.desktop`,
 * so the "no existing file" branch's `desktop-file-install` source path
 * was always wrong and silently failed on every genuinely fresh install;
 * (2) on a machine with the real desktop app also installed, whichever
 * one launched most recently would silently overwrite the other's
 * `~/.local/share/applications/VRCX.desktop` entry — the Name/Exec a user
 * clicks in their app launcher would flip depending on launch order, the
 * exact "which VRCX is this" confusion this fork's whole naming pass
 * exists to avoid. Both are fixed by using this fork's own distinct
 * filename throughout — it can never collide with the real app's entry,
 * and now actually matches what's bundled.
 * @returns void
 */
function updateDesktopFile() {
    if (noDesktop) {
        console.log('Skipping desktop file creation.');
        return;
    }

    const desktopFileName = 'VRCX-Headless.desktop';
    const applicationsDir = path.join(homePath, '.local/share/applications');
    const existingDesktopFilePath = path.join(applicationsDir, desktopFileName);

    // Found live (2026-08-28): a plain double-click launch (going through
    // this Exec= line, with no argv of its own to add flags to) crashed
    // outright — a real SIGTRAP/coredump, not a graceful failure — on a
    // Wayland+Vulkan session, matching the exact native-ozone-platform
    // incompatibility `tryRelaunchWithArgs()` above already exists to work
    // around. That function can't reliably win this race: Chromium's own
    // ozone-platform selection happens natively, early enough that it can
    // beat our JS relaunch decision depending on system timing — reproduced
    // live as intermittent (some launches crashed, some didn't, all from
    // the exact same binary and Exec= line). The only actually reliable fix
    // is for the very first exec to already carry the flag, so there's
    // nothing left to race. `tryRelaunchWithArgs()` stays as a fallback for
    // launches that don't go through this Exec= line at all (a terminal,
    // a file manager, `--startup`, etc).
    const ozoneSuffix = x11 ? '' : ' --ozone-platform-hint=auto';
    // Found live the same day, on a machine with a custom CA cert imported
    // (`customCaCertPath`'s own doc comment above): even with that
    // self-relaunch's `env: process.env` fix, the *packaged* AppImage build
    // still hit the exact same "no window, nothing logged" failure the fix
    // was meant to solve — reproducible every time on that machine, despite
    // the identical code path working fine in an unpackaged dev run. The
    // packaged-vs-dev discrepancy itself wasn't root-caused (FUSE mounting,
    // `AppRun`'s own script logic, and sandbox/namespace probing were all
    // individually verified fine), so rather than leave every custom-CA-cert
    // user depending on a relaunch path proven flaky in exactly this
    // configuration, this Exec= line bakes the env var in directly via the
    // `env` command — a standard, well-supported Exec= pattern — so that
    // relaunch never needs to fire for a desktop-icon launch at all. Purely
    // additive: `customCaCertPath`'s own self-relaunch stays as the fallback
    // for a launch that doesn't go through this Exec= line (a terminal, a
    // file manager, `--startup`), and this line self-heals on the very next
    // launch after any `vrcx-import-ca-cert`/`vrcx-remove-ca-cert` call,
    // since `updateDesktopFile()` runs unconditionally on every startup.
    const caCertPrefix = fs.existsSync(customCaCertPath) ? `env NODE_EXTRA_CA_CERTS=${customCaCertPath} ` : '';
    const execValue = `${caCertPrefix}${appImagePath}${ozoneSuffix}`;

    // note that when using spawnSync you DO NOT quote any paths as they are passed directly to the process
    try {
        // Create/update the desktop file when needed
        if (fs.existsSync(existingDesktopFilePath)) {
            var editResult = spawnSync('desktop-file-edit', [
                '--set-key=Exec',
                `--set-value=${execValue}`,
                existingDesktopFilePath
            ]);

            if (editResult.error) {
                console.log(`Error trying to update ${desktopFileName} file: `, editResult.error.message);
            } else {
                console.log(`Updated desktop file: ${existingDesktopFilePath} to exec ${execValue}`);
            }
        } else {
            const exeDir = path.dirname(app.getPath('exe'));
            const packageAppImagePath = path.join(exeDir, desktopFileName);

            var installResult = spawnSync('desktop-file-install', [
                '--set-key=Exec',
                `--set-value=${execValue}`,
                `--dir=${applicationsDir}`,
                '--rebuild-mime-info-cache',
                packageAppImagePath
            ]);

            if (installResult.error) {
                console.log(`Error trying to install ${desktopFileName} file: `, installResult.error.message);
            } else {
                console.log(`Installed desktop file to: ${applicationsDir} using exec ${execValue}`);
            }
        }
    } catch (err) {
        console.error('Error creating desktop file:', err);
        dialog.showErrorBox('VRCX Headless Desktop', 'Failed to create desktop entry.');
        return;
    }
}

function getElectronUserDataPath() {
    const electronUserData = 'ElectronUserData';
    if (process.platform === 'win32') {
        return path.join(getVRCXPath(), electronUserData);
    }
    if (process.platform === 'darwin') {
        return path.join(process.env.HOME, 'Library/Caches/VRCX', electronUserData);
    }
    // Linux or other
    let cacheHome = process.env.XDG_CACHE_HOME;
    if (!cacheHome) {
        cacheHome = path.join(process.env.HOME, '.cache');
    }
    return path.join(cacheHome, 'VRCX', electronUserData);
}

function getVRCXPath() {
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA, 'VRCX');
    } else if (process.platform === 'darwin') {
        return path.join(process.env.HOME, 'Library/Application Support/VRCX');
    }
    // Linux or other
    let configHome = process.env.XDG_CONFIG_HOME;
    if (!configHome) {
        configHome = path.join(process.env.HOME, '.config');
    }
    return path.join(configHome, 'VRCX');
}

function getHomePath() {
    const relativeHomePath = path.join(app.getPath('home'));
    try {
        const absoluteHomePath = fs.realpathSync(relativeHomePath);
        return absoluteHomePath;
    } catch (err) {
        console.error('Error resolving absolute home path:', err);
        return relativeHomePath;
    }
}

function getVersion() {
    try {
        const versionFile = fs.readFileSync(path.join(rootDir, 'Version'), 'utf8').trim();

        // look for trailing git hash "-22bcd96" to indicate a nightly
        // upstream build; the displayed number itself is this fork's own
        // release version (package.json's `version`, patched at build time
        // by build-scripts/patch-package-version.js to the same
        // <vrcx-date-no-dots>.<fork-build>.0 scheme as the Docker/desktop
        // release tag — see CLAUDE.md's "Server/Docker versioning") rather
        // than upstream's own date-only `Version` file, so this actually
        // identifies which fork release is installed
        const version = versionFile.split('-');
        const forkVersion = app.getVersion();
        console.log('Version:', versionFile, 'Fork version:', forkVersion);
        if (version.length > 0 && version[version.length - 1].length == 7) {
            return `VRCX Headless Nightly ${forkVersion}`;
        } else {
            return `VRCX Headless ${forkVersion}`;
        }
    } catch (err) {
        console.error('Error reading Version:', err);
        return 'VRCX Headless Nightly Build';
    }
}

function isDotNetInstalled() {
    let dotnetPath;

    if (process.env.DOTNET_ROOT) {
        dotnetPath = path.join(process.env.DOTNET_ROOT, 'dotnet');
        if (!fs.existsSync(dotnetPath)) {
            // fallback to command
            dotnetPath = 'dotnet';
        }
    } else {
        // fallback to command
        dotnetPath = 'dotnet';
    }

    console.log('Checking for .NET installation at:', dotnetPath);

    // Fallback to system .NET runtime
    const result = spawnSync(dotnetPath, ['--list-runtimes'], {
        encoding: 'utf-8'
    });
    if (result.error) {
        console.error('Error checking .NET runtimes:', result.error);
        return false;
    }
    return result.stdout?.includes('.NETCore.App 10.0');
}

function tryCopyFromWinePrefix() {
    try {
        if (!fs.existsSync(getVRCXPath())) {
            // try copy from old wine path
            const userName = process.env.USER || process.env.USERNAME;
            const oldPath = path.join(homePath, '.local/share/vrcx/drive_c/users', userName, 'AppData/Roaming/VRCX');
            const newPath = getVRCXPath();
            if (fs.existsSync(oldPath)) {
                fs.mkdirSync(newPath, { recursive: true });
                const files = fs.readdirSync(oldPath);
                for (const file of files) {
                    const oldFilePath = path.join(oldPath, file);
                    const newFilePath = path.join(newPath, file);
                    if (fs.lstatSync(oldFilePath).isDirectory()) {
                        continue;
                    }
                    fs.copyFileSync(oldFilePath, newFilePath);
                }
            }
        }
    } catch (err) {
        console.error('Error copying from wine prefix:', err);
        dialog.showErrorBox('VRCX Headless Desktop', 'Failed to copy database from wine prefix.');
    }
}

function applyWindowState() {
    if (VRCXStorage.Get('VRCX_StartAsMinimizedState') === 'true' && startup) {
        if (getCloseToTray()) {
            mainWindow.hide();
            return;
        }
        mainWindow.minimize();
        return;
    }
    const windowState = parseInt(VRCXStorage.Get('VRCX_WindowState')) || -1;
    switch (windowState) {
        case -1:
            break;
        case 0:
            mainWindow.restore();
            break;
        case 1:
            mainWindow.minimize();
            break;
        case 2:
            mainWindow.maximize();
            break;
    }
}

app.whenReady().then(async () => {
    showSplash();
    const updateApplied = await checkAndInstallForkUpdate();
    closeSplash();
    if (updateApplied) {
        // This process has already called app.exit() and is on its way out
        // — see checkAndInstallForkUpdate's own doc comment for why the
        // rest of startup (createWindow()/createTray()/installVRCX(), all
        // of which spin up real GPU/tray/native state) must not run here.
        return;
    }
    createWindow();
    createTray();
    installVRCX();

    // only initialise when the app is ready otherwise it could get called early and crash the app
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else {
            // Ensure main window shows when clicking Dock icon (critical for macOS)
            if (mainWindow && !mainWindow.isVisible()) {
                mainWindow.show();
            }
        }
    });
});

function disposeOverlay() {
    if (!isOverlayActive) {
        return;
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        const { webContents } = overlayWindow;
        if (webContents && !webContents.isDestroyed()) {
            webContents.removeAllListeners('paint');
            webContents.stopPainting();
        }
        overlayWindow.close();
    }
    overlayWindow = undefined;
    isOverlayActive = false;
    if (fs.existsSync(OVERLAY_SHM_PATH)) {
        fs.unlinkSync(OVERLAY_SHM_PATH);
    }
}

app.on('before-quit', function () {
    //console.log('before-quit');

    // Mark it as a quitting state to make macOS Dock's "Quit" action take effect.
    appIsQuitting = true;
    scheduleForceExitFallback();
    disposeOverlay();
    destroyTray();

    app.exit(0);
});

app.on('window-all-closed', function () {
    //console.log('window-all-closed');
    disposeOverlay();

    if (process.platform !== 'darwin') {
        app.quit();
    }
});
