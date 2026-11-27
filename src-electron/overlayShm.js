// Fork-only (CLAUDE.md §5). How the offscreen VR overlay's frames reach the .NET side.
// Linux: a /dev/shm file that VRCXVRElectron maps. Windows: there is no /dev/shm, and .NET runs in-process
// (node-api-dotnet), so each frame is handed over directly (OverlayFrameSinkElectron.Submit) with no file I/O;
// the overlay repaints at up to 48 fps and a frame is 6 MB.

/**
 * @param {string} platform `process.platform`
 * @returns {'shm' | 'dotnet' | null} The frame transport, or null where the offscreen overlay isn't supported
 */
function getOverlayFrameTransport(platform) {
    if (platform === 'linux') {
        return 'shm';
    }
    if (platform === 'win32') {
        return 'dotnet';
    }
    return null;
}

/**
 * @param {string} platform `process.platform`
 * @returns {string | null} The frame file, or null where frames don't go through a file
 */
function getOverlayShmPath(platform) {
    return getOverlayFrameTransport(platform) === 'shm' ? '/dev/shm/vrcx_overlay' : null;
}

/**
 * The offscreen overlay window renders in physical pixels, so with display scaling (125% on Windows, fractional
 * scaling on Linux) Chromium's paint bitmap is larger than the window's DIP size, e.g. 1280x1920 instead of
 * 1024x1536. The .NET side reads the frame with a fixed row length, so an oversized bitmap shears sideways like a
 * lost TV sync. Returns the resize to apply, or null when the bitmap already has the expected size.
 *
 * @param {{ width: number; height: number }} size `NativeImage.getSize()` of the paint bitmap
 * @param {number} width Expected frame width
 * @param {number} height Expected frame height
 * @returns {{ width: number; height: number; quality: 'good' } | null}
 */
function getOverlayFrameResize(size, width, height) {
    if (size.width === width && size.height === height) {
        return null;
    }
    return { width, height, quality: 'good' };
}

/**
 * The hidden overlay window is created at the main window's saved position, and Windows clamps a new window to the
 * work area of the display it lands on: on a 1440p monitor with a taskbar the 1024x1536 window becomes 1024x1392.
 * The clamped bitmap was then stretched to 1536 rows, which pushed the bottom of the wrist panel (its status bar)
 * past row 512 into the head-locked HMD crop. Resizing the window after its first paint isn't clamped (resizing
 * before it stops painting altogether), so the paint handler asks this on every frame and resizes when it says so.
 *
 * @param {number[]} contentSize `BrowserWindow.getContentSize()` ([width, height], DIPs)
 * @param {number} width Expected frame width
 * @param {number} height Expected frame height
 * @param {number} nowMs Current time
 * @param {number | null} lastAttemptMs When the window was last resized, or null if never
 * @param {number} [retryMs] Minimum time between attempts, so a resize the OS refuses isn't retried every frame
 * @returns {boolean} Whether to call `setContentSize(width, height)` now
 */
function shouldResizeOverlayWindow(contentSize, width, height, nowMs, lastAttemptMs, retryMs = 5000) {
    if (contentSize[0] === width && contentSize[1] === height) {
        return false;
    }
    return lastAttemptMs === null || nowMs - lastAttemptMs >= retryMs;
}

/**
 * A paint bitmap can be scaled (display scaling, see getOverlayFrameResize) but must keep the frame's shape. A
 * clamped window's bitmap has a different aspect ratio, and stretching it misplaces the wrist/HMD split, so such
 * frames are dropped until the window is back to full size.
 *
 * @param {{ width: number; height: number }} size `NativeImage.getSize()` of the paint bitmap
 * @param {number} width Expected frame width
 * @param {number} height Expected frame height
 * @returns {boolean}
 */
function isOverlayFrameShapeValid(size, width, height) {
    if (size.width <= 0 || size.height <= 0) {
        return false;
    }
    // Allow a pixel of rounding from fractional scaling (e.g. 1.15 x 1536 isn't a whole number)
    return Math.abs((size.height * width) / size.width - height) <= 1;
}

module.exports = {
    getOverlayFrameTransport,
    getOverlayShmPath,
    getOverlayFrameResize,
    shouldResizeOverlayWindow,
    isOverlayFrameShapeValid
};
