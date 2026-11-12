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

module.exports = { getOverlayFrameTransport, getOverlayShmPath, getOverlayFrameResize };
