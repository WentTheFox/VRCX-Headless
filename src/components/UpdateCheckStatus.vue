<template>
    <Popover v-if="status" v-model:open="open">
        <PopoverTrigger as-child>
            <TooltipWrapper :content="tooltipContent" side="top">
                <div
                    class="flex items-center gap-1 px-2 h-[22px] whitespace-nowrap border-r border-border cursor-pointer hover:bg-accent">
                    <span class="inline-block size-2 rounded-full shrink-0 bg-status-online" />
                    <span class="text-foreground text-[11px]">{{ t('status_bar.update_check') }}</span>
                </div>
            </TooltipWrapper>
        </PopoverTrigger>
        <PopoverContent class="w-[320px] px-3 py-2.5" side="top" align="start">
            <div class="flex flex-col gap-2">
                <span class="font-semibold text-xs text-foreground">{{ t('status_bar.update_check') }}</span>
                <p class="text-[11px] text-foreground m-0">
                    {{
                        t('status_bar.update_check_available', {
                            version: status.latestVrcxVersion
                        })
                    }}
                </p>
                <p v-if="status.forkReleaseAvailable" class="text-[11px] text-muted-foreground m-0">
                    {{ t('status_bar.update_check_fork_ready', { tag: status.forkReleaseTag }) }}
                </p>
                <template v-else>
                    <p class="text-[11px] text-muted-foreground m-0">
                        {{ t('status_bar.update_check_fork_missing') }}
                    </p>
                    <Button size="sm" class="h-6 px-2 text-[11px] self-start" @click="openIssue">
                        {{ t('status_bar.update_check_open_issue') }}
                    </Button>
                </template>
            </div>
        </PopoverContent>
    </Popover>
</template>

<script setup>
    import { computed, onMounted, ref } from 'vue';
    import { useI18n } from 'vue-i18n';

    import { Button } from '@/components/ui/button';
    import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
    import { TooltipWrapper } from '@/components/ui/tooltip';
    import { openExternalLink } from '@/shared/utils';

    const { t } = useI18n();

    const open = ref(false);
    /** @type {import('vue').Ref<null | { latestVrcxVersion: string, forkReleaseAvailable: boolean, forkReleaseTag: string | null, issueUrl: string | null }>} */
    const status = ref(null);

    const tooltipContent = computed(() =>
        status.value?.forkReleaseAvailable
            ? t('status_bar.update_check_fork_ready', { tag: status.value.forkReleaseTag })
            : t('status_bar.update_check_fork_missing')
    );

    /**
     * Only meaningful for a client actually connected to a headless server —
     * `WINDOWS`/CefSharp is the classic standalone app with its own local
     * install, no server to ask. `WEB` fetches same-origin; the desktop
     * client goes through `window.vrcxDesktopAgent` the same way every
     * other server-facing call here does (the renderer can't reach the
     * server directly — CORS).
     */
    async function refreshStatus() {
        if (WINDOWS) {
            return;
        }
        try {
            let result;
            if (WEB) {
                const response = await fetch('/api/update-check', {
                    credentials: 'same-origin'
                });
                if (!response.ok) return;
                const body = await response.json();
                result = body.ok ? body.result : null;
            } else {
                const body = await window.vrcxDesktopAgent.checkForUpdate();
                result = body.ok ? body.result : null;
            }
            status.value = result?.vrcxUpdateAvailable ? result : null;
        } catch {
            // Best-effort — the indicator just stays hidden until the next check.
        }
    }

    function openIssue() {
        if (status.value?.issueUrl) {
            openExternalLink(status.value.issueUrl);
        }
    }

    onMounted(() => {
        refreshStatus();
    });
</script>
