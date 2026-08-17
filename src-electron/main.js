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
    Notification,
    nativeImage
} = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const { WebSocket: WsClient } = require('ws');

//app.disableHardwareAcceleration();

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
            'VRCX',
            'Please install .NET 10.0 Runtime "dotnet-runtime-10.0" to run VRCX.'
        );
        app.quit();
    });
}

const VRCX_URI_PREFIX = 'vrcx';
let isOverlayActive = false;
let appIsQuitting = false;
const rootDir = app.getAppPath();

let tray = null;
let trayIcon = null;
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
const noUpdater =
    args.includes('--no-updater') ||
    fs.existsSync(path.join(rootDir, '.no-updater'));
if (process.defaultApp && process.platform !== 'win32') {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(VRCX_URI_PREFIX, process.execPath, [
            path.resolve(process.argv[1])
        ]);
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
const OVERLAY_SHARED_HEIGHT =
    OVERLAY_WRIST_FRAME_HEIGHT + OVERLAY_HMD_FRAME_HEIGHT;
const OVERLAY_SHARED_WIDTH = Math.max(
    OVERLAY_WRIST_FRAME_WIDTH,
    OVERLAY_HMD_FRAME_WIDTH
);
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

ipcMain.handle('callDotNetMethod', (event, className, methodName, args) => {
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
/** @type {import('ws').WebSocket | null} */
let agentSocket = null;
/** @type {NodeJS.Timeout | null} */
let agentReconnectTimer = null;

/**
 * @param {string} url
 * @param {import('node:https').RequestOptions & { body?: string }} options
 * @returns {Promise<{ status: number, body: any }>}
 */
async function fetchJson(url, options) {
    const response = await fetch(url, options);
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
            const result = await interopApi.callMethod(
                className,
                methodName,
                Array.isArray(args) ? args : []
            );
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
        const { status: httpStatus, body } = await fetchJson(
            `${serverUrl}/api/session/refresh`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverToken}`
                },
                body: '{}'
            }
        );
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
 * Shared by `connectToServer` and `confirmTotpSetup` — both end with "we
 * have a fresh session token for this server, remember it and open the
 * agent channel."
 * @param {string} normalizedUrl
 * @param {string} token
 */
function completeSession(normalizedUrl, token) {
    serverUrl = normalizedUrl;
    serverToken = token;
    VRCXStorage.Set('VRCX_ServerUrl', serverUrl);
    VRCXStorage.Set('VRCX_ServerToken', serverToken);
    VRCXStorage.Save();
    connectAgentSocket();
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
        throw new Error(
            response.body?.error ??
                `Could not reach the server (${response.status})`
        );
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

// Lets client-desktop/setup.js pre-fill the URL step with what's already
// stored (VRCX_ServerUrl, read into `serverUrl` at startup) instead of
// asking for it again on every `serve` restart — sessions are
// process-lifetime only (phase 3), so this screen reappears often, but the
// server address itself rarely changes.
ipcMain.handle('vrcx-get-stored-server-url', () => serverUrl);

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

ipcMain.handle('vrcx-rpc', async (_event, target, method, args) => {
    if (!serverUrl || !serverToken) {
        return { ok: false, error: 'Not connected to a server' };
    }
    try {
        const { status: httpStatus, body } = await fetchJson(
            `${serverUrl}/api/rpc`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${serverToken}`
                },
                body: JSON.stringify({ target, method, args })
            }
        );
        if (httpStatus === 401) {
            return {
                ok: false,
                error: 'Not authenticated with the VRCX server'
            };
        }
        return (
            body ?? { ok: false, error: `Unexpected response (${httpStatus})` }
        );
    } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
    }
});

// #endregion

/** @type {Electron.CrossProcessExports.BrowserWindow} */
let mainWindow = undefined;

const VRCXStorage = interopApi.getDotNetObject('VRCXStorage');
const hasAskedToMoveAppImage =
    VRCXStorage.Get('VRCX_HasAskedToMoveAppImage') === 'true';

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
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow && commandLine.length >= 2) {
            try {
                mainWindow.webContents.send(
                    'launch-command',
                    commandLine
                        .pop()
                        .trim()
                        .replace(strip_vrcx_prefix_regex, '')
                );
            } catch (err) {
                console.error('Error processing second-instance command:', err);
            }
        }
    });

    app.on('open-url', (event, url) => {
        if (mainWindow && url) {
            mainWindow.webContents.send(
                'launch-command',
                url.replace(strip_vrcx_prefix_regex, '')
            );
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

ipcMain.handle('notification:showNotification', (event, title, body, icon) => {
    if (activeNotification) {
        activeNotification.close();
    }

    const notification = new Notification({
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

ipcMain.handle('app:restart', () => {
    if (process.platform === 'linux') {
        const options = {
            execPath: process.execPath,
            args: process.argv.slice(1)
        };
        if (appImagePath) {
            options.execPath = appImagePath;
            if (!x11 && !options.args.includes('--appimage-extract-and-run')) {
                options.args.unshift('--appimage-extract-and-run');
            }
        }
        app.relaunch(options);
        destroyTray();
        app.exit(0);
    } else {
        app.relaunch();
        app.quit();
    }
});

ipcMain.handle('app:getOverlayWindow', () => {
    if (overlayWindow && overlayWindow.webContents) {
        return (
            !overlayWindow.webContents.isLoading() &&
            overlayWindow.webContents.isPainting()
        );
    }
    return false;
});

ipcMain.handle(
    'app:updateVr',
    (event, active, hmdOverlay, wristOverlay, menuButton, overlayHand) => {
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
    }
);

ipcMain.handle('app:getArch', () => {
    return process.arch.toString();
});
ipcMain.handle('app:getClipboardText', () => {
    return clipboard.readText();
});

ipcMain.handle('app:getNoUpdater', () => {
    return noUpdater;
});

ipcMain.handle('app:setTrayIconNotification', (event, notify) => {
    setTrayIconNotification(notify);
});

function tryRelaunchWithArgs(args) {
    if (
        process.platform !== 'linux' ||
        x11 ||
        args.includes('--ozone-platform-hint=auto')
    ) {
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

    destroyTray();
    app.exit(0);
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
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });
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
    serverUrl = VRCXStorage.Get('VRCX_ServerUrl') || null;
    serverToken = VRCXStorage.Get('VRCX_ServerToken') || null;
    refreshServerSession().then((connected) => {
        if (connected) {
            loadRealApp();
        } else {
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

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.control && input.key === '=') {
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() + 1
            );
        }
        if (input.control && input.key === '-') {
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() - 1
            );
        }
    });

    mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
        let currentZoom = mainWindow.webContents.getZoomLevel();
        if (zoomDirection === 'in') {
            mainWindow.webContents.setZoomLevel(++currentZoom);
        } else {
            mainWindow.webContents.setZoomLevel(--currentZoom);
        }
        VRCXStorage.Set('VRCX_ZoomLevel', currentZoom.toString());
    });
    mainWindow.webContents.setVisualZoomLevelLimits(1, 5);

    mainWindow.on('close', (event) => {
        if (getCloseToTray() && !appIsQuitting) {
            event.preventDefault();
            mainWindow.hide();
        } else {
            app.quit();
        }
    });

    mainWindow.on('resize', () => {
        const [width, height] = mainWindow
            .getSize()
            .map((size) => size.toString());
        mainWindow.webContents.send('setWindowSize', { width, height });
    });

    mainWindow.on('move', () => {
        const [x, y] = mainWindow
            .getPosition()
            .map((coord) => coord.toString());
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
    overlayWindow.webContents.on('paint', (event, dirty, image) => {
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
        const image = nativeImage.createFromPath(
            path.join(rootDir, 'images/VRCX.png')
        );
        trayIcon = image.resize({ width: 16, height: 16 });

        const imageNotify = nativeImage.createFromPath(
            path.join(rootDir, 'images/VRCX_notify.png')
        );
        trayIconNotify = imageNotify.resize({ width: 16, height: 16 });
    } else if (process.platform === 'linux') {
        const image = nativeImage.createFromPath(
            path.join(rootDir, 'images/VRCX.png')
        );
        trayIcon = image.resize({ width: 64, height: 64 });

        const imageNotify = nativeImage.createFromPath(
            path.join(rootDir, 'images/VRCX_notify.png')
        );
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
            label: 'Quit VRCX',
            type: 'normal',
            click: function () {
                appIsQuitting = true;
                app.quit();
            }
        }
    ]);
    tray.setToolTip('VRCX');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow.show();
    });
}

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

    // rename AppImage to VRCX.AppImage
    const currentName = path.basename(appImagePath);
    const expectedName = 'VRCX.AppImage';
    if (currentName !== expectedName) {
        const newPath = path.join(path.dirname(appImagePath), expectedName);
        try {
            // remove existing VRCX.AppImage
            if (fs.existsSync(newPath)) {
                fs.unlinkSync(newPath);
            }
            fs.renameSync(appImagePath, newPath);
            console.log('AppImage renamed to:', newPath);
            appImagePath = newPath;
        } catch (err) {
            console.error(`Error renaming AppImage ${newPath}`, err);
            dialog.showErrorBox('VRCX', `Failed to rename AppImage ${newPath}`);
            return;
        }
    }

    // ask to move AppImage to ~/Applications
    const appImageHomePath = `${homePath}/Applications/VRCX.AppImage`;
    if (!hasAskedToMoveAppImage && appImagePath !== appImageHomePath) {
        const result = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            title: 'VRCX',
            message: 'Do you want to install VRCX?',
            detail: 'VRCX will be moved to your ~/Applications folder.',
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
                // remove existing VRCX.AppImage
                if (fs.existsSync(appImageHomePath)) {
                    fs.unlinkSync(appImageHomePath);
                }
                fs.renameSync(appImagePath, appImageHomePath);
                appImagePath = appImageHomePath;
                console.log('AppImage moved to:', appImageHomePath);
                await createDesktopFile();
            } catch (err) {
                console.error(`Error moving AppImage ${appImageHomePath}`, err);
                dialog.showErrorBox(
                    'VRCX',
                    `Failed to move AppImage ${appImageHomePath}`
                );
                return;
            }
        }
    }

    // inform .NET side about AppImage path
    interopApi.getDotNetObject('Update').Init(appImagePath);
}

async function createDesktopFile() {
    if (noDesktop) {
        console.log('Skipping desktop file creation.');
        return;
    }

    // Download the icon and save it to the target directory
    const iconPath = path.join(homePath, '.local/share/icons/VRCX.png');
    if (!fs.existsSync(iconPath) || fs.statSync(iconPath).size === 0) {
        const iconDir = path.dirname(iconPath);
        if (!fs.existsSync(iconDir)) {
            fs.mkdirSync(iconDir, { recursive: true });
        }
        const iconUrl =
            'https://raw.githubusercontent.com/vrcx-team/VRCX/master/images/VRCX.png';
        await downloadIcon(iconUrl, iconPath)
            .then(() => {
                console.log('Icon downloaded and saved to:', iconPath);
            })
            .catch((err) => {
                console.error('Error downloading icon:', err);
                dialog.showErrorBox('VRCX', 'Failed to download the icon.');
            });
    }

    // Create the desktop file
    const desktopFilePath = path.join(
        homePath,
        '.local/share/applications/VRCX.desktop'
    );

    const dotDesktop = {
        Name: 'VRCX',
        Version: version,
        Comment: 'Friendship management tool for VRChat',
        Exec: `${appImagePath} --ozone-platform-hint=auto %U`,
        Icon: 'VRCX',
        Type: 'Application',
        Categories: 'Network;InstantMessaging;Game;',
        Terminal: 'false',
        StartupWMClass: 'VRCX',
        MimeType: 'x-scheme-handler/vrcx;'
    };
    const desktopFile =
        '[Desktop Entry]\n' +
        Object.entries(dotDesktop)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
    try {
        // Create the applications directory if it doesn't exist
        const desktopDir = path.dirname(desktopFilePath);
        if (!fs.existsSync(desktopDir)) {
            fs.mkdirSync(desktopDir, { recursive: true });
        }

        // Create/update the desktop file when needed
        let existingDesktopFile = '';
        if (fs.existsSync(desktopFilePath)) {
            existingDesktopFile = fs.readFileSync(desktopFilePath, 'utf8');
        }
        if (existingDesktopFile !== desktopFile) {
            fs.writeFileSync(desktopFilePath, desktopFile);
            console.log('Desktop file created at:', desktopFilePath);

            const result = spawnSync(
                'xdg-mime',
                ['default', 'VRCX.desktop', 'x-scheme-handler/vrcx'],
                {
                    encoding: 'utf-8'
                }
            );
            if (result.error) {
                console.error('Error setting MIME type:', result.error);
            } else {
                console.log('MIME type set x-scheme-handler/vrcx');
            }
        }
    } catch (err) {
        console.error('Error creating desktop file:', err);
        dialog.showErrorBox('VRCX', 'Failed to create desktop entry.');
        return;
    }
}

function downloadIcon(url, targetPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(targetPath);
        https
            .get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(
                        new Error(
                            `Failed to download icon, status code: ${response.statusCode}`
                        )
                    );
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close(resolve);
                });
            })
            .on('error', (err) => {
                fs.unlink(targetPath, () => reject(err)); // Delete the file if error occurs
            });
    });
}

function getElectronUserDataPath() {
    const electronUserData = 'ElectronUserData';
    if (process.platform === 'win32') {
        return path.join(getVRCXPath(), electronUserData);
    }
    if (process.platform === 'darwin') {
        return path.join(
            process.env.HOME,
            'Library/Caches/VRCX',
            electronUserData
        );
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
        const versionFile = fs
            .readFileSync(path.join(rootDir, 'Version'), 'utf8')
            .trim();

        // look for trailing git hash "-22bcd96" to indicate nightly build
        const version = versionFile.split('-');
        console.log('Version:', versionFile);
        if (version.length > 0 && version[version.length - 1].length == 7) {
            return `VRCX (Linux) Nightly ${versionFile}`;
        } else {
            return `VRCX (Linux) ${versionFile}`;
        }
    } catch (err) {
        console.error('Error reading Version:', err);
        return 'VRCX (Linux) Nightly Build';
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
            const oldPath = path.join(
                homePath,
                '.local/share/vrcx/drive_c/users',
                userName,
                'AppData/Roaming/VRCX'
            );
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
        dialog.showErrorBox(
            'VRCX',
            'Failed to copy database from wine prefix.'
        );
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

app.whenReady().then(() => {
    createWindow();
    createTray();
    installVRCX();

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
    // Mark it as a quitting state to make macOS Dock's "Quit" action take effect.
    appIsQuitting = true;
    disposeOverlay();
    destroyTray();
});

app.on('window-all-closed', function () {
    disposeOverlay();

    if (process.platform !== 'darwin') {
        app.quit();
    }
});
