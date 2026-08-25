import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { toast } from 'vue-sonner';
import { useI18n } from 'vue-i18n';

import { logWebRequest } from '../services/appConfig';
import { branches } from '../shared/constants';
import {
    getLatestWhatsNewRelease,
    getWhatsNewRelease,
    normalizeReleaseVersion
} from '../shared/constants/whatsNewReleases';
import { changeLogRemoveLinks } from '../shared/utils';

import configRepository from '../services/config';

import * as workerTimers from 'worker-timers';

const emptyWhatsNewDialog = () => ({
    visible: false,
    titleKey: '',
    subtitleKey: '',
    items: []
});

export const useVRCXUpdaterStore = defineStore('VRCXUpdater', () => {
    const { t } = useI18n();

    const arch = ref('x64');
    const noUpdater = ref(false);
    const isMacOS = computed(() => navigator.platform.includes('Mac'));

    const appVersion = ref('');
    // Fork addition (VRCX-Headless): `VERSION` is Vite's compile-time global
    // (src/vite.config.js's `define` block) — upstream's own date-only
    // `Version` file, installed the same way as a real global by
    // server/src/globals.js for the headless server. It's always this raw
    // upstream string regardless of platform/branding, unlike `appVersion`
    // above (this fork's own release version) — surfaced separately in
    // Settings as "Based on VRCX version" so the two don't get conflated.
    const upstreamVersion = ref('');
    const autoUpdateVRCX = ref('Auto Download');
    const latestAppVersion = ref('');
    const branch = ref('Stable');
    const vrcxId = ref('');
    const checkingForVRCXUpdate = ref(false);
    const VRCXUpdateDialog = ref({
        visible: false,
        updatePending: false,
        updatePendingIsLatest: false,
        release: '',
        releases: []
    });
    const changeLogDialog = ref({
        visible: false,
        buildName: '',
        changeLog: ''
    });
    const whatsNewDialog = ref(emptyWhatsNewDialog());
    const pendingVRCXUpdate = ref(false);
    const pendingVRCXInstall = ref('');
    const updateInProgress = ref(false);
    const updateProgress = ref(0);
    const updateToastRelease = ref('');

    async function initVRCXUpdaterSettings() {
        if (LINUX) {
            arch.value = await window.electron.getArch();
            noUpdater.value = await window.electron.getNoUpdater();
            console.log('Architecture:', arch.value);
        }
        if (isMacOS.value) {
            noUpdater.value = true;
        }
        // Fork addition (VRCX-Headless): the headless server has no install
        // flow this could ever act on, and unlike a real client build,
        // nothing here ever sets `noUpdater` from a native `getNoUpdater()`
        // call — left unguarded, this store's own self-invoked init (below)
        // hits VRCX's update API on every server boot for nothing, logging a
        // spurious "Failed to check for VRCX update" if that API is
        // unreachable from wherever `serve` happens to be deployed.
        // `HEADLESS` only ever exists as a real global on the server
        // (server/src/globals.js) — undefined, hence falsy, everywhere else.
        if (typeof HEADLESS !== 'undefined' && HEADLESS) {
            noUpdater.value = true;
        }

        const [VRCX_autoUpdateVRCX, VRCX_id] = await Promise.all([
            configRepository.getString('VRCX_autoUpdateVRCX', 'Auto Download'),
            configRepository.getString('VRCX_id', '')
        ]);

        if (VRCX_autoUpdateVRCX === 'Auto Install') {
            autoUpdateVRCX.value = 'Auto Download';
        } else {
            autoUpdateVRCX.value = VRCX_autoUpdateVRCX;
        }
        if (noUpdater.value) {
            autoUpdateVRCX.value = 'Off';
        }

        appVersion.value = await AppApi.GetVersion();
        upstreamVersion.value = VERSION;
        vrcxId.value = VRCX_id;

        await initBranch();
        await loadVrcxId();

        let checkedForUpdatesDuringAnnouncement = false;
        if (await shouldAnnounceCurrentVersion()) {
            const shown = await showWhatsNewDialog();
            if (shown) {
                await markCurrentVersionAsSeen();
            } else if (isRecognizedStableReleaseVersion()) {
                const result = await showChangeLogDialog({ prefetch: true });
                checkedForUpdatesDuringAnnouncement = result.checkedForUpdates;
                if (result.shown) {
                    await markCurrentVersionAsSeen();
                }
            }
        } else {
            await syncCurrentVersionState();
        }
        if (autoUpdateVRCX.value !== 'Off' && !checkedForUpdatesDuringAnnouncement) {
            await checkForVRCXUpdate();
        }
    }

    const currentVersion = computed(() => appVersion.value.replace(' Headless', ''));

    // Fork addition (VRCX-Headless): the server-driven desktop updater.
    // Deliberately separate state/functions from everything above —
    // `checkForVRCXUpdate`/`getAssetOfInterest`/`downloadVRCXUpdate`/etc.
    // stay exactly as upstream wrote them, pointed at upstream's own
    // `api0.vrcx.app` channel and permanently dormant behind `.no-updater`
    // (CLAUDE.md §9). This is a wholly new, additive flow: the server and
    // desktop client are released together under the same
    // `<vrcx-date>.<fork-build>.0` version, so the right update target for
    // a given install isn't "whatever's newest on GitHub" but "whatever the
    // connected server is running" — see CLAUDE.md's desktop-updater
    // write-up for the full design.
    const forkUpdateStatus = ref('idle'); // 'idle' | 'checking' | 'in-sync' | 'installing' | 'mismatch-offline'
    const forkServerVersion = ref('');
    const forkUpdateError = ref('');

    // Bare `<vrcx-date>.<minor>.<patch>`, stripped of the `VRCX `/`VRCX
    // Nightly ` prefix `currentVersion` still carries — this is what's
    // actually compared against the target release version below.
    const installedForkVersion = computed(() => currentVersion.value.replace(/^VRCX (Nightly )?/, ''));

    /**
     * Windows-only for now (per CLAUDE.md's "Desktop client OS support" —
     * this is the one fork platform genuinely shipped/tested end to end).
     * Extending to Linux later is just adding a second branch here matching
     * upstream's own `getAssetOfInterest`'s `.AppImage` logic
     * (`vrcxUpdater.js`'s untouched Linux branch above) — `Dotnet/Update.cs`'s
     * AppImage in-place-swap path and everything else already works
     * unmodified regardless of which asset URL/hash it's given.
     * @param {Array<{name: string, digest?: string, size: number, downloadUrl: string}>} assets
     * @param {string} archValue
     * @returns {{ downloadUrl: string, hashString: string, size: number } | null}
     */
    function getForkAssetOfInterest(assets, archValue) {
        const suffix = `win-${archValue}.exe`;
        const asset = assets.find((a) => a.name.endsWith(suffix));
        if (!asset) {
            return null;
        }
        return {
            downloadUrl: asset.downloadUrl,
            hashString: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : '',
            size: asset.size
        };
    }

    /**
     * @param {{ force?: boolean }} [options]
     */
    async function checkForForkUpdate(options = {}) {
        if (!LINUX || typeof updateService === 'undefined') {
            // Web/CefSharp: no desktop install to update, or not this
            // fork's own branded distribution (§1) — nothing to do.
            return;
        }
        if (!/^\d+\.\d+\.\d+$/.test(installedForkVersion.value)) {
            // A dev/unbuilt run ("VRCX Nightly Build") never matches the
            // fork's real version scheme — same "ignore custom builds"
            // guard upstream's own checkForVRCXUpdate applies for the same
            // reason.
            return;
        }
        forkUpdateStatus.value = 'checking';
        let info;
        try {
            info = await updateService.getUpdateInfo(options);
        } catch (err) {
            forkUpdateStatus.value = 'mismatch-offline';
            forkUpdateError.value = err?.message ?? String(err);
            toast.error(t('message.vrcx_updater.fork_check_failed', { message: forkUpdateError.value }));
            return;
        }
        forkServerVersion.value = info.serverVersion;
        if (!info.release) {
            // Nothing published yet under the server's own MINOR — can't
            // tell whether the client is actually up to date, so report the
            // uncertainty rather than silently doing nothing.
            forkUpdateStatus.value = 'mismatch-offline';
            forkUpdateError.value = '';
            toast.error(
                t('message.vrcx_updater.fork_mismatch', {
                    client: installedForkVersion.value,
                    server: info.serverVersion
                })
            );
            return;
        }
        // Compared against the release actually offered, not
        // `info.serverVersion` directly — a client-only PATCH release never
        // needs the server redeployed (CLAUDE.md's "Server/Docker
        // versioning"), so the server can legitimately still be reporting
        // an older PATCH than the newest one published under its own MINOR.
        const targetVersion = info.release.tag.replace(/^v/, '');
        if (targetVersion === installedForkVersion.value) {
            forkUpdateStatus.value = 'in-sync';
            return;
        }
        await installForkUpdate(info.release);
    }

    /**
     * @param {{ assets: Array<{name: string, digest?: string, size: number, downloadUrl: string}> }} release
     */
    async function installForkUpdate(release) {
        if (updateInProgress.value) {
            // Already busy with either update flow (upstream's own or this
            // one) — reusing the same flag keeps the two from racing each
            // other, even though upstream's is permanently dormant today.
            return;
        }
        const asset = getForkAssetOfInterest(release.assets, arch.value);
        if (!asset) {
            forkUpdateStatus.value = 'mismatch-offline';
            forkUpdateError.value = `No matching installer for win-${arch.value}`;
            toast.error(
                t('message.vrcx_updater.fork_mismatch', {
                    client: installedForkVersion.value,
                    server: forkServerVersion.value
                })
            );
            return;
        }
        try {
            updateInProgress.value = true;
            forkUpdateStatus.value = 'installing';
            await downloadFileProgress();
            await AppApi.DownloadUpdate(asset.downloadUrl, asset.hashString, asset.size);
            // Dotnet/Update.cs's Update.Check() only installs the downloaded
            // update.exe on the *next* process start — restart now so
            // "fully automatic" actually means installed, not "installed
            // whenever the app next happens to relaunch".
            restartVRCX(true);
        } catch (err) {
            forkUpdateStatus.value = 'mismatch-offline';
            forkUpdateError.value = err?.message ?? String(err);
            toast.error(t('message.vrcx_updater.fork_install_failed', { message: forkUpdateError.value }));
        } finally {
            updateInProgress.value = false;
            updateProgress.value = 0;
        }
    }

    /**
     * @param {string} value
     */
    async function setAutoUpdateVRCX(value) {
        if (value === 'Off') {
            pendingVRCXUpdate.value = false;
        }
        autoUpdateVRCX.value = value;
        await configRepository.setString('VRCX_autoUpdateVRCX', value);
    }
    /**
     * @param {string} value
     */
    function setLatestAppVersion(value) {
        latestAppVersion.value = value;
    }
    /**
     * @param {string} value
     */
    function setBranch(value) {
        branch.value = value;
        configRepository.setString('VRCX_branch', value);
    }

    async function initBranch() {
        if (!appVersion.value) {
            return;
        }
        if (currentVersion.value.includes('VRCX Nightly')) {
            branch.value = 'Nightly';
        } else {
            branch.value = 'Stable';
        }
        await configRepository.setString('VRCX_branch', branch.value);
    }

    async function hasVersionChanged() {
        const lastVersion = await configRepository.getString('VRCX_lastVRCXVersion', '');
        return lastVersion !== currentVersion.value;
    }

    async function markCurrentVersionAsSeen() {
        await configRepository.setString('VRCX_lastVRCXVersion', currentVersion.value);
    }

    async function syncCurrentVersionState() {
        if (await hasVersionChanged()) {
            await markCurrentVersionAsSeen();
            return true;
        }
        return false;
    }

    async function shouldAnnounceCurrentVersion() {
        if (branch.value !== 'Stable' || !isRecognizedStableReleaseVersion()) {
            return false;
        }
        const lastVersion = await configRepository.getString('VRCX_lastVRCXVersion', '');
        return Boolean(lastVersion) && lastVersion !== currentVersion.value;
    }

    function isRecognizedStableReleaseVersion() {
        return Boolean(normalizeReleaseVersion(currentVersion.value));
    }

    /**
     * @returns {Promise<boolean>}
     */
    async function showWhatsNewDialog() {
        const release = getWhatsNewRelease(currentVersion.value);

        if (!release) {
            whatsNewDialog.value = emptyWhatsNewDialog();
            return false;
        }

        whatsNewDialog.value = {
            visible: true,
            titleKey: release.titleKey,
            subtitleKey: release.subtitleKey,
            items: release.items.map((item) => ({ ...item }))
        };

        return true;
    }

    // function showLatestWhatsNewDialog() {
    //     const release = getLatestWhatsNewRelease();

    //     if (!release) {
    //         return false;
    //     }

    //     whatsNewDialog.value = {
    //         visible: true,
    //         titleKey: release.titleKey,
    //         subtitleKey: release.subtitleKey,
    //         items: release.items.map((item) => ({ ...item }))
    //     };

    //     return true;
    // }

    function closeWhatsNewDialog() {
        whatsNewDialog.value.visible = false;
    }

    async function openChangeLogDialogOnly() {
        changeLogDialog.value.visible = true;
        if (!changeLogDialog.value.buildName || !changeLogDialog.value.changeLog) {
            await checkForVRCXUpdate();
        }
    }
    async function loadVrcxId() {
        if (!vrcxId.value) {
            vrcxId.value = crypto.randomUUID();
            await configRepository.setString('VRCX_id', vrcxId.value);
        }
    }
    function getAssetOfInterest(assets) {
        let downloadUrl = '';
        let hashString = '';
        let size = 0;
        for (const asset of assets) {
            if (asset.state !== 'uploaded') {
                continue;
            }
            if (
                WINDOWS &&
                asset.name.endsWith('.exe') &&
                (asset.content_type === 'application/x-msdownload' ||
                    asset.content_type === 'application/x-msdos-program')
            ) {
                downloadUrl = asset.browser_download_url;
                if (asset.digest && asset.digest.startsWith('sha256:')) {
                    hashString = asset.digest.replace('sha256:', '');
                }
                size = asset.size;
                break;
            }
            if (
                LINUX &&
                asset.name.endsWith(`${arch.value}.AppImage`) &&
                asset.content_type === 'application/octet-stream'
            ) {
                downloadUrl = asset.browser_download_url;
                if (asset.digest && asset.digest.startsWith('sha256:')) {
                    hashString = asset.digest.replace('sha256:', '');
                }
                size = asset.size;
                break;
            }
        }
        return { downloadUrl, hashString, size };
    }
    async function checkForVRCXUpdate() {
        if (
            !currentVersion.value ||
            currentVersion.value === 'VRCX Nightly Build' ||
            currentVersion.value === 'VRCX Build'
        ) {
            // ignore custom builds
            return false;
        }
        if (branch.value === 'Beta') {
            // move Beta users to stable
            setBranch('Stable');
        }
        if (typeof branches[branch.value] === 'undefined') {
            // handle invalid branch
            setBranch('Stable');
        }
        const url = branches[branch.value].urlLatest;
        checkingForVRCXUpdate.value = true;
        let response;
        let json;
        try {
            response = await webApiService.execute({
                url,
                method: 'GET',
                headers: {
                    'VRCX-ID': vrcxId.value
                }
            });
            json = JSON.parse(response.data);
        } catch (error) {
            console.error('Failed to check for VRCX update', error);
            return false;
        } finally {
            checkingForVRCXUpdate.value = false;
        }
        if (response.status !== 200) {
            toast.error(
                t('message.vrcx_updater.failed', {
                    message: `${response.status} ${response.data}`
                })
            );
            return false;
        }
        pendingVRCXUpdate.value = false;
        logWebRequest('[EXTERNAL GET]', url, `(${response.status})`, json);
        if (json === Object(json) && json.name && json.published_at) {
            changeLogDialog.value.buildName = json.name;
            changeLogDialog.value.changeLog = changeLogRemoveLinks(json.body);
            const releaseName = json.name;
            setLatestAppVersion(releaseName);
            VRCXUpdateDialog.value.updatePendingIsLatest = false;
            if (autoUpdateVRCX.value === 'Off') {
                return true;
            }
            if (releaseName === pendingVRCXInstall.value) {
                // update already downloaded
                VRCXUpdateDialog.value.updatePendingIsLatest = true;
            } else if (releaseName > currentVersion.value) {
                const { downloadUrl, hashString, size } = getAssetOfInterest(json.assets);
                if (!downloadUrl) {
                    return true;
                }
                pendingVRCXUpdate.value = true;
                if (updateToastRelease.value !== releaseName) {
                    updateToastRelease.value = releaseName;
                    toast(t('nav_menu.update_available'), {
                        description: releaseName,
                        duration: 5000,
                        action: {
                            label: t('nav_menu.update'),
                            onClick: () => showVRCXUpdateDialog()
                        }
                    });
                }
                if (autoUpdateVRCX.value === 'Notify') {
                    // this.showVRCXUpdateDialog();
                } else if (autoUpdateVRCX.value === 'Auto Download') {
                    await downloadVRCXUpdate(downloadUrl, hashString, size, releaseName);
                }
            }
            return true;
        }
        return false;
    }
    async function showVRCXUpdateDialog() {
        const D = VRCXUpdateDialog.value;
        D.visible = true;
        D.updatePendingIsLatest = false;
        D.updatePending = await AppApi.CheckForUpdateExe();
        if (updateInProgress.value) {
            return;
        }
        await loadBranchVersions();
    }

    async function loadBranchVersions() {
        const D = VRCXUpdateDialog.value;
        const url = branches[branch.value].urlReleases;
        checkingForVRCXUpdate.value = true;
        let response;
        let json;
        try {
            response = await webApiService.execute({
                url,
                method: 'GET',
                headers: {
                    'VRCX-ID': vrcxId.value
                }
            });
            json = JSON.parse(response.data);
        } catch (error) {
            console.error('Failed to check for VRCX update', error);
            return;
        } finally {
            checkingForVRCXUpdate.value = false;
        }
        if (response.status !== 200) {
            toast.error(
                t('message.vrcx_updater.failed', {
                    message: `${response.status} ${response.data}`
                })
            );
            return;
        }
        logWebRequest('[EXTERNAL GET]', url, `(${response.status})`, json);
        const releases = [];
        if (typeof json !== 'object' || json.message) {
            toast.error(
                t('message.vrcx_updater.failed', {
                    message: json.message
                })
            );
            return;
        }
        for (const release of json) {
            if (release.prerelease) {
                continue;
            }
            assetLoop: for (const asset of release.assets) {
                if (asset.state === 'uploaded') {
                    releases.push(release);
                    break assetLoop;
                }
            }
        }
        D.releases = releases;
        D.release = json[0].name;
        VRCXUpdateDialog.value.updatePendingIsLatest = false;
        if (D.release === pendingVRCXInstall.value) {
            // update already downloaded and latest version
            VRCXUpdateDialog.value.updatePendingIsLatest = true;
        }
        setBranch(branch.value);
    }
    async function downloadVRCXUpdate(downloadUrl, hashString, size, releaseName) {
        if (updateInProgress.value) {
            return;
        }
        try {
            updateInProgress.value = true;
            await downloadFileProgress();
            await AppApi.DownloadUpdate(downloadUrl, hashString, size);
            pendingVRCXInstall.value = releaseName;
        } catch (err) {
            console.error(err);
            toast.error(`${t('message.vrcx_updater.failed_install')} ${err}`);
        } finally {
            updateInProgress.value = false;
            updateProgress.value = 0;
        }
    }
    async function downloadFileProgress() {
        updateProgress.value = await AppApi.CheckUpdateProgress();
        if (updateInProgress.value) {
            workerTimers.setTimeout(() => downloadFileProgress(), 150);
        }
    }
    function installVRCXUpdate() {
        for (const release of VRCXUpdateDialog.value.releases) {
            if (release.name !== VRCXUpdateDialog.value.release) {
                continue;
            }
            const { downloadUrl, hashString, size } = getAssetOfInterest(release.assets);
            if (!downloadUrl) {
                return;
            }
            const releaseName = release.name;
            downloadVRCXUpdate(downloadUrl, hashString, size, releaseName);
            break;
        }
    }
    async function showChangeLogDialog(options = {}) {
        const { prefetch = false } = options;

        if (prefetch) {
            const loaded = await ensureChangeLogReady();
            if (!loaded) {
                return { shown: false, checkedForUpdates: true };
            }
            changeLogDialog.value.visible = true;
            return { shown: true, checkedForUpdates: true };
        }

        changeLogDialog.value.visible = true;
        void ensureChangeLogReady();
        return { shown: true, checkedForUpdates: true };
    }

    async function ensureChangeLogReady() {
        if (changeLogDialog.value.buildName && changeLogDialog.value.changeLog) {
            return true;
        }
        return checkForVRCXUpdate();
    }
    function restartVRCX(isUpgrade) {
        if (!LINUX) {
            AppApi.RestartApplication(isUpgrade);
        } else {
            window.electron.restartApp();
        }
    }
    function updateProgressText() {
        if (updateProgress.value === 100) {
            return t('message.vrcx_updater.checking_hash');
        }
        return `${updateProgress.value}%`;
    }
    async function cancelUpdate() {
        await AppApi.CancelUpdate();
        updateInProgress.value = false;
        updateProgress.value = 0;
    }

    initVRCXUpdaterSettings();

    return {
        appVersion,
        upstreamVersion,
        autoUpdateVRCX,
        latestAppVersion,
        branch,
        currentVersion,
        vrcxId,
        checkingForVRCXUpdate,
        VRCXUpdateDialog,
        changeLogDialog,
        whatsNewDialog,
        pendingVRCXUpdate,
        pendingVRCXInstall,
        updateInProgress,
        updateProgress,
        noUpdater,

        setAutoUpdateVRCX,
        setBranch,

        showWhatsNewDialog,
        closeWhatsNewDialog,
        openChangeLogDialogOnly,
        checkForVRCXUpdate,
        loadBranchVersions,
        installVRCXUpdate,
        showVRCXUpdateDialog,
        showChangeLogDialog,
        restartVRCX,
        updateProgressText,
        cancelUpdate,

        forkUpdateStatus,
        forkServerVersion,
        forkUpdateError,
        installedForkVersion,
        checkForForkUpdate
    };
});
