import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
    configRepository: {
        getString: vi.fn(),
        setString: vi.fn()
    },
    changeLogRemoveLinks: vi.fn((value) => value),
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        warning: vi.fn()
    }
}));

vi.mock('../../services/config', () => ({
    default: mocks.configRepository
}));

vi.mock('../../shared/utils', () => ({
    changeLogRemoveLinks: (...args) => mocks.changeLogRemoveLinks(...args)
}));

vi.mock('vue-sonner', () => ({
    toast: mocks.toast
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({
        t: (key) => key,
        locale: require('vue').ref('en')
    })
}));

function flushPromises() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

import { useVRCXUpdaterStore } from '../vrcxUpdater';

describe('useVRCXUpdaterStore.setAutoUpdateVRCX', () => {
    beforeEach(async () => {
        mocks.configRepository.getString.mockImplementation((key, defaultValue) => {
            if (key === 'VRCX_autoUpdateVRCX') {
                return Promise.resolve('Off');
            }
            if (key === 'VRCX_id') {
                return Promise.resolve('test-vrcx-id');
            }
            if (key === 'VRCX_lastVRCXVersion') {
                return Promise.resolve('2026.1.0');
            }
            return Promise.resolve(defaultValue ?? '');
        });
        mocks.configRepository.setString.mockResolvedValue(undefined);

        globalThis.AppApi = {
            GetVersion: vi.fn().mockResolvedValue('2026.1.0')
        };

        setActivePinia(createPinia());
        useVRCXUpdaterStore();
        await flushPromises();
        vi.clearAllMocks();
    });

    test('sets autoUpdateVRCX to Off, clears pending flag, and persists config', async () => {
        const store = useVRCXUpdaterStore();
        store.pendingVRCXUpdate = true;

        await store.setAutoUpdateVRCX('Off');

        expect(store.autoUpdateVRCX).toBe('Off');
        expect(store.pendingVRCXUpdate).toBe(false);
        expect(mocks.configRepository.setString).toHaveBeenCalledWith('VRCX_autoUpdateVRCX', 'Off');
    });

    test('updates autoUpdateVRCX for non-Off values and keeps pending flag', async () => {
        const store = useVRCXUpdaterStore();
        store.pendingVRCXUpdate = true;

        await store.setAutoUpdateVRCX('Notify');

        expect(store.autoUpdateVRCX).toBe('Notify');
        expect(store.pendingVRCXUpdate).toBe(true);
        expect(mocks.configRepository.setString).toHaveBeenCalledWith('VRCX_autoUpdateVRCX', 'Notify');
    });
});

describe('useVRCXUpdaterStore.checkForForkUpdate', () => {
    beforeEach(async () => {
        mocks.configRepository.getString.mockImplementation((_key, defaultValue) =>
            Promise.resolve(defaultValue ?? '')
        );
        mocks.configRepository.setString.mockResolvedValue(undefined);

        globalThis.LINUX = true;
        globalThis.AppApi = {
            GetVersion: vi.fn().mockResolvedValue('VRCX Headless 20260718.11.0'),
            DownloadUpdate: vi.fn().mockResolvedValue(undefined),
            CheckUpdateProgress: vi.fn().mockResolvedValue(0)
        };
        window.electron = {
            getArch: vi.fn().mockResolvedValue('x64'),
            getNoUpdater: vi.fn().mockResolvedValue(false),
            restartApp: vi.fn()
        };
        globalThis.updateService = {
            getUpdateInfo: vi.fn()
        };

        setActivePinia(createPinia());
        useVRCXUpdaterStore();
        await flushPromises();
        vi.clearAllMocks();
    });

    afterAll(() => {
        globalThis.LINUX = false;
        delete globalThis.updateService;
        delete window.electron;
    });

    test('reports in-sync when the offered release matches the installed version', async () => {
        // The offered release, not the server's own reported version, is
        // what determines in-sync now — a client-only PATCH release never
        // needs the server redeployed, so the two can legitimately differ
        // (see the "offers a newer PATCH" test below).
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.11.0',
            release: { tag: 'v20260718.11.0', assets: [] }
        });

        await store.checkForForkUpdate();

        expect(store.forkUpdateStatus).toBe('in-sync');
        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
    });

    test('downloads, verifies, and restarts automatically when a matching release exists', async () => {
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.12.0',
            release: {
                tag: 'v20260718.12.0',
                assets: [
                    {
                        name: 'VRCX.Headless.Setup.20260718.12.0.win-x64.exe',
                        digest: `sha256:${'1'.repeat(64)}`,
                        size: 42,
                        downloadUrl: 'https://example.invalid/win-x64.exe'
                    },
                    {
                        name: 'VRCX.Headless.Setup.20260718.12.0.win-arm64.exe',
                        digest: `sha256:${'2'.repeat(64)}`,
                        size: 99,
                        downloadUrl: 'https://example.invalid/win-arm64.exe'
                    }
                ]
            }
        });

        await store.checkForForkUpdate();

        expect(globalThis.AppApi.DownloadUpdate).toHaveBeenCalledWith(
            'https://example.invalid/win-x64.exe',
            '1'.repeat(64),
            42
        );
        expect(window.electron.restartApp).toHaveBeenCalled();
    });

    test('installs a newer PATCH release even though the server itself still reports an older PATCH', async () => {
        // update-release.js offers the highest PATCH published under the
        // server's own MINOR, not an exact match of what the server
        // currently reports — a PATCH-only release is client-only by
        // definition and never requires the server to be redeployed.
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.11.0',
            release: {
                tag: 'v20260718.11.2',
                assets: [
                    {
                        name: 'VRCX.Headless.Setup.20260718.11.2.win-x64.exe',
                        digest: `sha256:${'3'.repeat(64)}`,
                        size: 42,
                        downloadUrl: 'https://example.invalid/win-x64.exe'
                    }
                ]
            }
        });

        await store.checkForForkUpdate();

        expect(globalThis.AppApi.DownloadUpdate).toHaveBeenCalledWith(
            'https://example.invalid/win-x64.exe',
            '3'.repeat(64),
            42
        );
        expect(window.electron.restartApp).toHaveBeenCalled();
    });

    test('refuses to downgrade when the offered release is older than what is installed', async () => {
        // Guards against update-release.js's own 30-minute cache offering a
        // stale answer right after a newer release was just published —
        // found live causing a real downgrade-then-reinstall loop.
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.10.0',
            release: {
                tag: 'v20260718.10.0',
                assets: [
                    {
                        name: 'VRCX.Headless.Setup.20260718.10.0.win-x64.exe',
                        digest: `sha256:${'4'.repeat(64)}`,
                        size: 42,
                        downloadUrl: 'https://example.invalid/win-x64.exe'
                    }
                ]
            }
        });

        await store.checkForForkUpdate();

        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
        expect(window.electron.restartApp).not.toHaveBeenCalled();
        expect(store.forkUpdateStatus).toBe('in-sync');
    });

    test('warns without installing when the mismatched server version has no published release yet', async () => {
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.12.0',
            release: null
        });

        await store.checkForForkUpdate();

        expect(store.forkUpdateStatus).toBe('mismatch-offline');
        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
        expect(mocks.toast.error).toHaveBeenCalled();
    });

    test('refuses to install when a matching asset has no verifiable sha256 digest', async () => {
        // Guards against GitHub ever changing its digest algorithm (or
        // dropping it) — should surface as a loud failure, never a silent
        // "nothing to install" that looks identical to being up to date.
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.12.0',
            release: {
                tag: 'v20260718.12.0',
                assets: [
                    {
                        name: 'VRCX.Headless.Setup.20260718.12.0.win-x64.exe',
                        digest: 'sha512:not-actually-sha256',
                        size: 42,
                        downloadUrl: 'https://example.invalid/win-x64.exe'
                    }
                ]
            }
        });

        await store.checkForForkUpdate();

        expect(globalThis.AppApi.DownloadUpdate).not.toHaveBeenCalled();
        expect(window.electron.restartApp).not.toHaveBeenCalled();
        expect(store.forkUpdateStatus).toBe('mismatch-offline');
        expect(store.forkUpdateError).toContain('no verifiable sha256 digest');
        expect(mocks.toast.error).toHaveBeenCalled();
    });

    test('does nothing outside the Electron build', async () => {
        globalThis.LINUX = false;
        const store = useVRCXUpdaterStore();

        await store.checkForForkUpdate();

        expect(globalThis.updateService.getUpdateInfo).not.toHaveBeenCalled();
        globalThis.LINUX = true;
    });
});
