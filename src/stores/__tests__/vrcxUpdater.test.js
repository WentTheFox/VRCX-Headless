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

    test('reports in-sync when the server version matches the installed version', async () => {
        const store = useVRCXUpdaterStore();
        globalThis.updateService.getUpdateInfo.mockResolvedValue({
            serverVersion: '20260718.11.0',
            release: null
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
                assets: [
                    {
                        name: 'VRCX.Headless.Setup.20260718.12.0.win-x64.exe',
                        digest: 'sha256:abc123',
                        size: 42,
                        downloadUrl: 'https://example.invalid/win-x64.exe'
                    },
                    {
                        name: 'VRCX.Headless.Setup.20260718.12.0.win-arm64.exe',
                        digest: 'sha256:def456',
                        size: 99,
                        downloadUrl: 'https://example.invalid/win-arm64.exe'
                    }
                ]
            }
        });

        await store.checkForForkUpdate();

        expect(globalThis.AppApi.DownloadUpdate).toHaveBeenCalledWith(
            'https://example.invalid/win-x64.exe',
            'abc123',
            42
        );
        expect(window.electron.restartApp).toHaveBeenCalled();
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

    test('does nothing outside the Electron build', async () => {
        globalThis.LINUX = false;
        const store = useVRCXUpdaterStore();

        await store.checkForForkUpdate();

        expect(globalThis.updateService.getUpdateInfo).not.toHaveBeenCalled();
        globalThis.LINUX = true;
    });
});
