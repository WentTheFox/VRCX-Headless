import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// src-electron/overlayShm.js is CommonJS and shared with the Electron main process
const require = createRequire(import.meta.url);
const { getOverlayFrameTransport, getOverlayShmPath, getOverlayFrameResize } = require('../../src-electron/overlayShm.js');

describe('getOverlayFrameTransport', () => {
    it('uses the /dev/shm file on Linux', () => {
        expect(getOverlayFrameTransport('linux')).toBe('shm');
    });

    it('hands frames to .NET in-process on Windows', () => {
        expect(getOverlayFrameTransport('win32')).toBe('dotnet');
    });

    it('returns null where the offscreen overlay is unsupported', () => {
        expect(getOverlayFrameTransport('darwin')).toBeNull();
        expect(getOverlayFrameTransport('freebsd')).toBeNull();
    });
});

describe('getOverlayShmPath', () => {
    it('uses /dev/shm on Linux', () => {
        expect(getOverlayShmPath('linux')).toBe('/dev/shm/vrcx_overlay');
    });

    it('has no frame file on Windows or unsupported platforms', () => {
        expect(getOverlayShmPath('win32')).toBeNull();
        expect(getOverlayShmPath('darwin')).toBeNull();
    });
});

describe('getOverlayFrameResize', () => {
    it('leaves a frame of the expected size alone', () => {
        expect(getOverlayFrameResize({ width: 1024, height: 1536 }, 1024, 1536)).toBeNull();
    });

    it('scales a HiDPI bitmap (125% display scaling) back to the frame size', () => {
        expect(getOverlayFrameResize({ width: 1280, height: 1920 }, 1024, 1536)).toEqual({
            width: 1024,
            height: 1536,
            quality: 'good'
        });
    });

    it('also resizes when only one dimension differs', () => {
        expect(getOverlayFrameResize({ width: 1024, height: 1535 }, 1024, 1536)).not.toBeNull();
    });
});
