/**
 * The preload script runs before `index.html` is loaded
 * in the renderer. It has access to web APIs as well as
 * Electron's renderer process modules and some polyfilled
 * Node.js functions.
 *
 * https://www.electronjs.org/docs/latest/tutorial/sandbox
 */
const { contextBridge, ipcRenderer, app } = require('electron');

const managedListeners = new Map();

function registerManagedListener(channel, callback, mapKey = channel) {
    const existingListener = managedListeners.get(mapKey);
    if (existingListener) {
        ipcRenderer.removeListener(channel, existingListener);
    }

    const listener = (event, ...args) => callback(event, ...args);
    managedListeners.set(mapKey, listener);
    ipcRenderer.on(channel, listener);

    return () => {
        const currentListener = managedListeners.get(mapKey);
        if (currentListener === listener) {
            ipcRenderer.removeListener(channel, listener);
            managedListeners.delete(mapKey);
        }
    };
}

contextBridge.exposeInMainWorld('LINUX', true);
contextBridge.exposeInMainWorld('WINDOWS', false);

contextBridge.exposeInMainWorld('interopApi', {
    callDotNetMethod: (className, methodName, args) => {
        return ipcRenderer.invoke('callDotNetMethod', className, methodName, args);
    }
});

// Phase 5: routes client-desktop/shims/*.js's database/config/webapi calls
// (and client-desktop/setup.js's initial connect) through the main
// process, which does the actual authenticated fetch to the headless
// server — see src-electron/main.js's own doc comment on why (CORS from a
// renderer to a remote origin).
contextBridge.exposeInMainWorld('vrcxDesktopAgent', {
    connectToServer: (url, code) => ipcRenderer.invoke('vrcx-connect-server', url, code),
    checkTotpSetupNeeded: (url) => ipcRenderer.invoke('vrcx-totp-setup', url),
    confirmTotpSetup: (url, secret, code) => ipcRenderer.invoke('vrcx-totp-confirm', url, secret, code),
    rpc: (target, method, args) => ipcRenderer.invoke('vrcx-rpc', target, method, args),
    // Multi-server: src/components/HeadlessServerStatus.vue's post-auth
    // switcher panel, and client-desktop/setup.js's pre-auth picker. Adding
    // a *new* server reuses connectToServer/confirmTotpSetup above — see
    // src-electron/main.js's own comment on why that half needs no separate
    // IPC channel.
    listServers: () => ipcRenderer.invoke('vrcx-list-servers'),
    switchServer: (url) => ipcRenderer.invoke('vrcx-switch-server', url),
    removeServer: (url) => ipcRenderer.invoke('vrcx-remove-server', url),
    setDefaultServer: (url) => ipcRenderer.invoke('vrcx-set-default-server', url),
    getServerStatus: () => ipcRenderer.invoke('vrcx-get-server-status'),
    onServerStatusChanged: (callback) =>
        registerManagedListener('vrcx-server-status-changed', (_event, status) => callback(status)),
    // Self-signed-server TLS trust: see src-electron/main.js's
    // `vrcx-import-ca-cert` doc comment for why this needs a restart
    // (window.electron.restartApp()) to actually take effect.
    importCaCert: () => ipcRenderer.invoke('vrcx-import-ca-cert'),
    removeCaCert: () => ipcRenderer.invoke('vrcx-remove-ca-cert'),
    getCaCertStatus: () => ipcRenderer.invoke('vrcx-get-ca-cert-status'),
    // Pipeline relay (client-desktop/shims/pipeline-relay.js): `send`, not
    // `invoke`, since these are fire-and-forget — the actual data comes back
    // asynchronously via onStreamEvent, not as this call's return value.
    streamConnect: () => ipcRenderer.send('vrcx-stream-connect'),
    streamClose: () => ipcRenderer.send('vrcx-stream-close'),
    onStreamEvent: (callback) => registerManagedListener('vrcx-stream-event', (_event, evt) => callback(evt)),
    checkForUpdate: () => ipcRenderer.invoke('vrcx-check-update')
});

const validChannels = ['launch-command'];

contextBridge.exposeInMainWorld('electron', {
    getArch: () => ipcRenderer.invoke('app:getArch'),
    getClipboardText: () => ipcRenderer.invoke('app:getClipboardText'),
    getNoUpdater: () => ipcRenderer.invoke('app:getNoUpdater'),
    setTrayIconNotification: (notify) => ipcRenderer.invoke('app:setTrayIconNotification', notify),
    openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
    openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
    onWindowPositionChanged: (callback) => registerManagedListener('setWindowPosition', callback),
    onWindowSizeChanged: (callback) => registerManagedListener('setWindowSize', callback),
    onWindowStateChange: (callback) => registerManagedListener('setWindowState', callback),
    onBrowserFocus: (callback) => registerManagedListener('onBrowserFocus', callback),
    desktopNotification: (title, body, icon) => ipcRenderer.invoke('notification:showNotification', title, body, icon),
    restartApp: () => ipcRenderer.invoke('app:restart'),
    getOverlayWindow: () => ipcRenderer.invoke('app:getOverlayWindow'),
    updateVr: (active, hmdOverlay, wristOverlay, menuButton, overlayHand) =>
        ipcRenderer.invoke('app:updateVr', active, hmdOverlay, wristOverlay, menuButton, overlayHand),
    ipcRenderer: {
        on(channel, func) {
            if (validChannels.includes(channel)) {
                return registerManagedListener(channel, (_event, ...args) => func(...args), `ipcRenderer:${channel}`);
            }

            return undefined;
        }
    }
});
