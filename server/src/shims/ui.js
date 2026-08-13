/**
 * Headless stand-in for `src/stores/ui.js`.
 *
 * The real store calls `document.body.addEventListener` at store-setup scope
 * (`:273`) and pulls `@vueuse/core` via `useMagicKeys()` (`:31`) — both
 * fail outright under Node. What it's *for* is dialog bookkeeping (open/close,
 * breadcrumbs, menu highlighting), and a headless process has no dialogs, so
 * this stub stays forever — same reasoning as `server/src/shims/modal.js`.
 *
 * Every method here is a no-op reproduction of what its callers in
 * `src/coordinators/*Coordinator.js` and `src/stores/{instance,user}.js`
 * actually use (grepped, not guessed). `openDialog` always returns `false`
 * (`hadActiveDialog`), so callers always take their normal fetch/refresh
 * path rather than the "already open, just relabel" shortcut — the correct
 * behaviour when nothing can ever be "already open".
 */
import { defineStore } from 'pinia';

export const useUiStore = defineStore('Ui', () => {
    function openDialog() {
        return false;
    }
    function setDialogCrumbLabel() {}
    function jumpBackDialogCrumb() {}
    function clearDialogCrumbs() {}
    function notifyMenu() {}

    return {
        openDialog,
        setDialogCrumbLabel,
        jumpBackDialogCrumb,
        clearDialogCrumbs,
        notifyMenu
    };
});
