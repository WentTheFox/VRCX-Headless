/**
 * Renderer half of the update-check splash window
 * (`src-electron/main.js`'s `showSplash()`/`updateSplashStatus()`) — just
 * reflects whatever status text the main process pushes while
 * `checkAndInstallForkUpdate()` runs. `window.vrcxSplash` is exposed by
 * `client-desktop/splash-preload.js`; no other capability needed here, this
 * window never sends anything back to the main process.
 */
window.vrcxSplash.onStatus((text) => {
    document.getElementById('status').textContent = text;
});
