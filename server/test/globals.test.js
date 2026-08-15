/**
 * `server/src/globals.js`'s agent-aware `AppApi`/`LogWatcher`/`Discord`/
 * `AssetBundleManager` polyfills (phase 5) — with no desktop agent
 * connected these must behave exactly like phase 2b's original no-op
 * `AppApi` (a DB/API-only deployment shouldn't change at all), and with one
 * connected, calls must forward through `desktopAgent.call`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopAgent } from '../src/agent.js';
import {
    installAppApiPolyfill,
    installAssetBundleManagerPolyfill,
    installDiscordPolyfill,
    installHistoryPolyfill,
    installLogWatcherPolyfill,
    installUnhandledRejectionReporting
} from '../src/globals.js';

describe('agent-aware globals', () => {
    afterEach(() => {
        delete globalThis.AppApi;
        delete globalThis.LogWatcher;
        delete globalThis.Discord;
        delete globalThis.AssetBundleManager;
        vi.restoreAllMocks();
    });

    it('no-ops without throwing when no agent is connected', async () => {
        vi.spyOn(desktopAgent, 'isConnected').mockReturnValue(false);
        installLogWatcherPolyfill();
        await expect(
            globalThis.LogWatcher.GetLogLines()
        ).resolves.toBeUndefined();
    });

    it('forwards to the agent when one is connected', async () => {
        vi.spyOn(desktopAgent, 'isConnected').mockReturnValue(true);
        const call = vi
            .spyOn(desktopAgent, 'call')
            .mockResolvedValue(['line one', 'line two']);
        installLogWatcherPolyfill();

        const result = await globalThis.LogWatcher.GetLogLines();

        expect(call).toHaveBeenCalledWith('LogWatcher', 'GetLogLines', []);
        expect(result).toEqual(['line one', 'line two']);
    });

    it('forwards Discord calls with their arguments intact', async () => {
        vi.spyOn(desktopAgent, 'isConnected').mockReturnValue(true);
        const call = vi.spyOn(desktopAgent, 'call').mockResolvedValue(true);
        installDiscordPolyfill();

        const result = await globalThis.Discord.SetActive(true);

        expect(call).toHaveBeenCalledWith('Discord', 'SetActive', [true]);
        expect(result).toBe(true);
    });

    it('forwards AssetBundleManager calls', async () => {
        vi.spyOn(desktopAgent, 'isConnected').mockReturnValue(true);
        const call = vi.spyOn(desktopAgent, 'call').mockResolvedValue(1024);
        installAssetBundleManagerPolyfill();

        const result = await globalThis.AssetBundleManager.GetCacheSize();

        expect(call).toHaveBeenCalledWith(
            'AssetBundleManager',
            'GetCacheSize',
            []
        );
        expect(result).toBe(1024);
    });

    it('AppApi.GetVersion stays a real override, never forwarded', async () => {
        globalThis.VERSION = '2026.99.99-test';
        vi.spyOn(desktopAgent, 'isConnected').mockReturnValue(true);
        const call = vi.spyOn(desktopAgent, 'call');
        installAppApiPolyfill();

        const result = await globalThis.AppApi.GetVersion();

        expect(result).toBe('2026.99.99-test');
        expect(call).not.toHaveBeenCalled();
    });

    it('propagates a rejected agent call rather than swallowing it', async () => {
        vi.spyOn(desktopAgent, 'isConnected').mockReturnValue(true);
        vi.spyOn(desktopAgent, 'call').mockRejectedValue(
            new Error('native call exploded')
        );
        installLogWatcherPolyfill();

        await expect(globalThis.LogWatcher.Get()).rejects.toThrow(
            'native call exploded'
        );
    });
});

describe('installHistoryPolyfill', () => {
    afterEach(() => {
        delete globalThis.history;
    });

    it('provides the state property vue-router reads in finalizeNavigation', () => {
        installHistoryPolyfill();

        expect(globalThis.history.state).toBeNull();
        expect(() => globalThis.history.pushState()).not.toThrow();
        expect(() => globalThis.history.replaceState()).not.toThrow();
        expect(() => globalThis.history.go()).not.toThrow();
    });

    it('does not override an existing history global', () => {
        globalThis.history = { state: 'real' };

        installHistoryPolyfill();

        expect(globalThis.history.state).toBe('real');
    });
});

describe('installUnhandledRejectionReporting', () => {
    let baselineListeners;

    beforeEach(() => {
        baselineListeners = process.listeners('unhandledRejection');
    });

    afterEach(() => {
        for (const listener of process.listeners('unhandledRejection')) {
            if (!baselineListeners.includes(listener)) {
                process.removeListener('unhandledRejection', listener);
            }
        }
    });

    it('registers a listener so an unhandled rejection does not crash the process', () => {
        const before = process.listenerCount('unhandledRejection');

        installUnhandledRejectionReporting();

        expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    });

    it('logs rather than rethrowing when a rejection is emitted', () => {
        installUnhandledRejectionReporting();

        expect(() => {
            process.emit(
                'unhandledRejection',
                new Error('simulated'),
                Promise.reject().catch(() => {})
            );
        }).not.toThrow();
    });
});
