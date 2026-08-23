<template>
    <Popover v-model:open="open">
        <PopoverTrigger as-child>
            <TooltipWrapper :content="tooltipContent" side="top">
                <div
                    class="flex items-center gap-1 px-2 h-[22px] whitespace-nowrap border-r border-border cursor-pointer hover:bg-accent">
                    <span
                        class="inline-block size-2 rounded-full shrink-0"
                        :class="status.reachable ? 'bg-status-online' : 'bg-status-offline-alt'" />
                    <span class="text-foreground text-[11px]">{{ t('status_bar.headless') }}</span>
                    <span v-if="status.label" class="text-[10px] text-foreground max-w-[120px] truncate">{{
                        status.label
                    }}</span>
                </div>
            </TooltipWrapper>
        </PopoverTrigger>
        <PopoverContent class="w-[320px] px-3 py-2.5" side="top" align="start">
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span class="font-semibold text-xs text-foreground">{{ t('status_bar.headless_servers') }}</span>
                    <Button
                        v-if="addStep === 'closed'"
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-[11px]"
                        @click="startAddServer">
                        + {{ t('status_bar.headless_add') }}
                    </Button>
                </div>

                <div v-if="addStep === 'closed'" class="flex flex-col gap-1">
                    <div
                        v-for="server in servers"
                        :key="server.url"
                        class="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-accent/60">
                        <span
                            class="inline-block size-2 rounded-full shrink-0"
                            :class="
                                server.active
                                    ? status.reachable
                                        ? 'bg-status-online'
                                        : 'bg-status-offline-alt'
                                    : 'bg-muted-foreground'
                            " />
                        <div
                            class="flex flex-col min-w-0 flex-1"
                            :class="server.active ? '' : 'cursor-pointer'"
                            @click="!server.active && !busy && requestSwitch(server.url)">
                            <span class="text-[11px] text-foreground truncate"
                                >{{ server.label
                                }}<span v-if="server.isDefault" class="text-muted-foreground"> ★</span></span
                            >
                            <span class="text-[10px] text-muted-foreground truncate">{{ server.url }}</span>
                        </div>
                        <button
                            v-if="!server.isDefault"
                            type="button"
                            class="text-[10px] text-muted-foreground hover:text-foreground shrink-0"
                            :disabled="busy"
                            @click="makeDefault(server.url)">
                            {{ t('status_bar.headless_set_default') }}
                        </button>
                        <button
                            v-if="!server.active"
                            type="button"
                            class="text-[10px] text-destructive hover:opacity-80 shrink-0"
                            :disabled="busy"
                            @click="requestRemove(server.url)">
                            ✕
                        </button>
                    </div>
                    <p v-if="servers.length === 0" class="text-[11px] text-muted-foreground m-0">
                        {{ t('status_bar.headless_none') }}
                    </p>
                </div>

                <div v-if="addStep === 'closed'" class="flex flex-col gap-1 border-t border-border pt-2">
                    <span class="text-[11px] text-foreground">{{ t('status_bar.headless_ca_cert') }}</span>
                    <p class="text-[10px] text-muted-foreground m-0">
                        {{
                            caCertRestartNeeded
                                ? t('status_bar.headless_ca_cert_restart_required')
                                : caCertImported
                                  ? t('status_bar.headless_ca_cert_imported')
                                  : t('status_bar.headless_ca_cert_none')
                        }}
                    </p>
                    <p v-if="caCertError" class="text-[11px] text-destructive m-0">{{ caCertError }}</p>
                    <div class="flex gap-2">
                        <Button
                            v-if="caCertRestartNeeded"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            @click="window.electron.restartApp()">
                            {{ t('status_bar.headless_ca_cert_restart_now') }}
                        </Button>
                        <Button
                            v-else-if="caCertImported"
                            variant="destructive"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="caCertBusy"
                            @click="removeCaCert">
                            {{ t('status_bar.headless_ca_cert_remove') }}
                        </Button>
                        <Button
                            v-else
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="caCertBusy"
                            @click="importCaCert">
                            {{ t('status_bar.headless_ca_cert_import') }}
                        </Button>
                    </div>
                </div>

                <div v-if="pendingSwitchUrl" class="flex flex-col gap-1.5 border-t border-border pt-2">
                    <p class="text-[11px] text-foreground m-0">
                        {{ t('status_bar.headless_switch_confirm', { url: pendingSwitchUrl }) }}
                    </p>
                    <p v-if="switchError" class="text-[11px] text-destructive m-0">{{ switchError }}</p>
                    <div class="flex gap-2">
                        <Button
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="confirmSwitch(pendingSwitchUrl)">
                            {{ t('status_bar.headless_switch') }}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="pendingSwitchUrl = null">
                            {{ t('status_bar.headless_cancel') }}
                        </Button>
                    </div>
                </div>

                <div v-if="pendingRemoveUrl" class="flex flex-col gap-1.5 border-t border-border pt-2">
                    <p class="text-[11px] text-foreground m-0">
                        {{ t('status_bar.headless_remove_confirm', { url: pendingRemoveUrl }) }}
                    </p>
                    <div class="flex gap-2">
                        <Button
                            variant="destructive"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="confirmRemove(pendingRemoveUrl)">
                            {{ t('status_bar.headless_remove') }}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="pendingRemoveUrl = null">
                            {{ t('status_bar.headless_cancel') }}
                        </Button>
                    </div>
                </div>

                <form
                    v-if="addStep === 'url'"
                    class="flex flex-col gap-1.5 border-t border-border pt-2"
                    @submit.prevent="submitAddUrl">
                    <Input v-model="addUrl" placeholder="http://192.168.1.5:9000" class="h-7 text-[11px]" autofocus />
                    <p v-if="addError" class="text-[11px] text-destructive m-0">{{ addError }}</p>
                    <div class="flex gap-2">
                        <Button type="submit" size="sm" class="h-6 px-2 text-[11px]" :disabled="busy">
                            {{ t('status_bar.headless_continue') }}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="cancelAdd">
                            {{ t('status_bar.headless_cancel') }}
                        </Button>
                    </div>
                </form>

                <form
                    v-else-if="addStep === 'totp-setup'"
                    class="flex flex-col gap-1.5 border-t border-border pt-2"
                    @submit.prevent="submitAddCode">
                    <p class="text-[11px] text-muted-foreground m-0">{{ t('status_bar.headless_scan') }}</p>
                    <img
                        v-if="addQrDataUrl"
                        :src="addQrDataUrl"
                        alt="TOTP QR code"
                        class="self-center rounded bg-white p-1" />
                    <p class="text-[10px] text-muted-foreground m-0 break-all font-mono text-center">
                        {{ addSecret }}
                    </p>
                    <Input
                        v-model="addCode"
                        placeholder="6-digit code"
                        class="h-7 text-[11px] tracking-[0.2em]"
                        maxlength="6"
                        inputmode="numeric"
                        autofocus />
                    <p v-if="addError" class="text-[11px] text-destructive m-0">{{ addError }}</p>
                    <div class="flex gap-2">
                        <Button type="submit" size="sm" class="h-6 px-2 text-[11px]" :disabled="busy">
                            {{ t('status_bar.headless_confirm') }}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="cancelAdd">
                            {{ t('status_bar.headless_cancel') }}
                        </Button>
                    </div>
                </form>

                <form
                    v-else-if="addStep === 'totp-login'"
                    class="flex flex-col gap-1.5 border-t border-border pt-2"
                    @submit.prevent="submitAddCode">
                    <Input
                        v-model="addCode"
                        placeholder="6-digit code"
                        class="h-7 text-[11px] tracking-[0.2em]"
                        maxlength="6"
                        inputmode="numeric"
                        autofocus />
                    <p v-if="addError" class="text-[11px] text-destructive m-0">{{ addError }}</p>
                    <div class="flex gap-2">
                        <Button type="submit" size="sm" class="h-6 px-2 text-[11px]" :disabled="busy">
                            {{ t('status_bar.headless_connect') }}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            class="h-6 px-2 text-[11px]"
                            :disabled="busy"
                            @click="cancelAdd">
                            {{ t('status_bar.headless_cancel') }}
                        </Button>
                    </div>
                </form>
            </div>
        </PopoverContent>
    </Popover>
</template>

<script setup>
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import { useI18n } from 'vue-i18n';
    import qrcode from 'qrcode-generator';

    import { Button } from '@/components/ui/button';
    import { Input } from '@/components/ui/input';
    import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
    import { TooltipWrapper } from '@/components/ui/tooltip';
    import { useVRCXUpdaterStore } from '@/stores';

    const { t } = useI18n();
    const vrcxUpdaterStore = useVRCXUpdaterStore();

    // Only mounted when LINUX (see StatusBar.vue's `v-if="isLinux"`), so
    // `window.vrcxDesktopAgent` — installed by src-electron/preload.js — is
    // always present here.
    const agent = window.vrcxDesktopAgent;

    const open = ref(false);
    const busy = ref(false);
    const status = ref({ url: null, label: '', reachable: true });
    const servers = ref([]);

    const pendingSwitchUrl = ref(null);
    const pendingRemoveUrl = ref(null);
    const switchError = ref('');

    const addStep = ref('closed');
    const addUrl = ref('');
    const addCode = ref('');
    const addSecret = ref('');
    const addQrDataUrl = ref('');
    const addError = ref('');

    const caCertImported = ref(false);
    const caCertRestartNeeded = ref(false);
    const caCertBusy = ref(false);
    const caCertError = ref('');

    const tooltipContent = computed(() => {
        const state = status.value.reachable
            ? t('status_bar.headless_reachable')
            : t('status_bar.headless_unreachable');
        return status.value.label ? `${status.value.label}: ${state}` : state;
    });

    let unsubscribeStatus = null;

    /**
     *
     */
    async function refreshStatus() {
        try {
            status.value = await agent.getServerStatus();
        } catch {
            // Best-effort — the trigger just keeps showing its last known state.
        }
        maybeCheckForForkUpdate(status.value.reachable);
    }

    // Fork addition (VRCX-Headless): the server-driven desktop updater
    // (src/stores/vrcxUpdater.js's checkForForkUpdate) is triggered from
    // here rather than from the store itself, since "on every server
    // connect/switch" is specifically a desktop/agent-channel concept this
    // fork-owned component already tracks — the upstream-shared store has
    // no notion of "which server" at all. A server *switch* already
    // restarts the whole Electron process (`vrcx-switch-server` in
    // src-electron/main.js), so it doesn't need its own separate trigger
    // here; this only needs to cover "became reachable," which is exactly
    // what both call sites below already represent (the initial snapshot
    // in refreshStatus(), and every edge the onServerStatusChanged
    // subscription pushes afterwards — main.js's setServerReachable()
    // already only sends on an actual flip, not on every poll).
    let lastCheckedReachable = null;
    function maybeCheckForForkUpdate(reachable) {
        if (!reachable || reachable === lastCheckedReachable) {
            return;
        }
        lastCheckedReachable = reachable;
        vrcxUpdaterStore.checkForForkUpdate();
    }

    /**
     *
     */
    async function refreshServers() {
        try {
            servers.value = await agent.listServers();
        } catch {
            servers.value = [];
        }
    }

    watch(open, (isOpen) => {
        if (!isOpen) return;
        pendingSwitchUrl.value = null;
        pendingRemoveUrl.value = null;
        switchError.value = '';
        cancelAdd();
        refreshServers();
        refreshCaCertStatus();
    });

    /**
     *
     */
    async function refreshCaCertStatus() {
        try {
            const { imported } = await agent.getCaCertStatus();
            caCertImported.value = imported;
        } catch {
            // Best-effort — the control just keeps showing its last known state.
        }
    }

    /**
     *
     */
    async function importCaCert() {
        caCertBusy.value = true;
        caCertError.value = '';
        try {
            const result = await agent.importCaCert();
            if (!result.ok) {
                caCertError.value = result.error ?? '';
                return;
            }
            caCertImported.value = true;
            caCertRestartNeeded.value = true;
        } catch (err) {
            caCertError.value = err.message ?? '';
        } finally {
            caCertBusy.value = false;
        }
    }

    /**
     *
     */
    async function removeCaCert() {
        caCertBusy.value = true;
        try {
            await agent.removeCaCert();
            caCertRestartNeeded.value = true;
        } finally {
            caCertBusy.value = false;
        }
    }

    /**
     * @param {string} url
     */
    function requestSwitch(url) {
        switchError.value = '';
        pendingSwitchUrl.value = url;
    }

    /**
     * @param {string} url
     */
    async function confirmSwitch(url) {
        busy.value = true;
        switchError.value = '';
        try {
            const result = await agent.switchServer(url);
            if (!result.ok) {
                switchError.value = result.error ?? t('status_bar.headless_switch_failed');
                busy.value = false;
            }
            // On success the main process restarts the app — nothing left to do.
        } catch (err) {
            switchError.value = err.message ?? t('status_bar.headless_switch_failed');
            busy.value = false;
        }
    }

    /**
     * @param {string} url
     */
    function requestRemove(url) {
        pendingRemoveUrl.value = url;
    }

    /**
     * @param {string} url
     */
    async function confirmRemove(url) {
        busy.value = true;
        try {
            await agent.removeServer(url);
            await refreshServers();
        } finally {
            busy.value = false;
            pendingRemoveUrl.value = null;
        }
    }

    /**
     * @param {string} url
     */
    async function makeDefault(url) {
        busy.value = true;
        try {
            await agent.setDefaultServer(url);
            await refreshServers();
        } finally {
            busy.value = false;
        }
    }

    /**
     *
     */
    function startAddServer() {
        addStep.value = 'url';
        addUrl.value = '';
        addCode.value = '';
        addSecret.value = '';
        addQrDataUrl.value = '';
        addError.value = '';
    }

    /**
     *
     */
    function cancelAdd() {
        addStep.value = 'closed';
    }

    /**
     *
     */
    async function submitAddUrl() {
        if (!addUrl.value) {
            addError.value = t('status_bar.headless_url_required');
            return;
        }
        busy.value = true;
        addError.value = '';
        try {
            const result = await agent.checkTotpSetupNeeded(addUrl.value);
            if (!result.ok) {
                addError.value = result.error ?? t('status_bar.headless_connect_failed');
                return;
            }
            if (result.needed) {
                addSecret.value = result.secret;
                addQrDataUrl.value = renderQrDataUrl(result.uri);
                addStep.value = 'totp-setup';
            } else {
                addStep.value = 'totp-login';
            }
        } catch (err) {
            addError.value = err.message ?? t('status_bar.headless_connect_failed');
        } finally {
            busy.value = false;
        }
    }

    /**
     *
     */
    async function submitAddCode() {
        busy.value = true;
        addError.value = '';
        try {
            const result =
                addStep.value === 'totp-setup'
                    ? await agent.confirmTotpSetup(addUrl.value, addSecret.value, addCode.value)
                    : await agent.connectToServer(addUrl.value, addCode.value);
            if (!result.ok) {
                addError.value = result.error ?? t('status_bar.headless_code_mismatch');
                busy.value = false;
                return;
            }
            // On success the main process reloads the whole app — nothing left to do.
        } catch (err) {
            addError.value = err.message ?? t('status_bar.headless_connect_failed');
            busy.value = false;
        }
    }

    /**
     * @param {string} uri
     * @returns {string}
     */
    function renderQrDataUrl(uri) {
        const qr = qrcode(0, 'M');
        qr.addData(uri);
        qr.make();
        return qr.createDataURL(6, 4);
    }

    onMounted(() => {
        refreshStatus();
        refreshCaCertStatus();
        unsubscribeStatus = agent.onServerStatusChanged((next) => {
            status.value = { ...status.value, ...next };
            maybeCheckForForkUpdate(next.reachable);
        });
    });

    onBeforeUnmount(() => {
        unsubscribeStatus?.();
    });
</script>
