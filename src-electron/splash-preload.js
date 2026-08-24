/**
 * Preload for the update-check splash window (`src-electron/main.js`'s
 * `showSplash()`) — deliberately its own tiny bridge rather than reusing
 * `preload.js`'s `vrcxDesktopAgent`, since the splash window has nothing to
 * do with the server connection, only a one-way status text push.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vrcxSplash', {
    onStatus: (callback) => ipcRenderer.on('splash-status', (_event, text) => callback(text))
});
