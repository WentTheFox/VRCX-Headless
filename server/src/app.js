/**
 * The throwaway app instance that makes injection-based composables work
 * inside store setup functions — phase 2b step 5 (CLAUDE.md § "Phase 2b
 * recipe").
 *
 * ## Why a mounted component, not just `app.use(pinia)`
 *
 * `useRouter()` / `useI18n()` are both just `inject(someKey)`, and ~20
 * stores call one or the other at setup scope (grepped: `charts.js`,
 * `friend.js`, `gameLog/index.js`, `settings/appearance.js`, and 14 more for
 * `useI18n()` alone). `setActivePinia(pinia)` alone leaves `inject()`
 * throwing "must be called at the top of a setup function" the moment any
 * of those stores gets instantiated — not at import time, which is why
 * steps 1-4 could ship without this.
 *
 * The obvious fix — `app.use(pinia).use(router).use(i18n)` on a bare
 * `createApp({})`, never mounted, relying on Pinia's `pinia._a.runWithContext`
 * to make `inject()` work outside a component — turns out not to be enough
 * either, and *why* is worth recording because it will look like it should
 * work: `runWithContext` sets Vue's app-context for the duration of the
 * function it wraps, but it is not a re-entrant stack. Nearly every store
 * here composes others (`friend.js` calls `useGroupStore()` before its own
 * `useRouter()`; `charts.js` calls `useFriendStore()` before its own). Each
 * nested `useXStore()` call gets its *own* `runWithContext`, and that
 * nested call's cleanup clears the context unconditionally on the way out
 * instead of restoring the outer call's — so by the time the *outer*
 * store's own `useRouter()` runs, the context is already gone. Verified
 * empirically: `useFriendStore()` alone (its own nested calls don't reach
 * `useRouter()`) instantiates fine; `useChartsStore()` (nests
 * `useFriendStore()`, which *does* call `useRouter()`) throws.
 *
 * The real client sidesteps this entirely: `src/App.vue`'s `<script setup>`
 * calls `createGlobalStores()` once, and because that runs inside an
 * *actual mounted component's* `setup()`, `getCurrentInstance()` is stable
 * for the whole synchronous call tree — there is no nested
 * `runWithContext` teardown to race, because nothing needed
 * `runWithContext` in the first place. This module reproduces exactly that:
 * a component whose `setup()` calls the same `createGlobalStores()`, mounted
 * for real so `inject()` has one stable instance underneath the whole tree.
 *
 * `app.mount()` needs a renderer, and `@vue/runtime-dom`'s wants a real
 * `window`/`SVGElement`/etc. that pulling in jsdom just to satisfy would be
 * exactly the kind of stub-that-grows-features invariant 3 warns against —
 * this component never renders anything (`render: () => null`), so instead
 * this uses `@vue/runtime-core`'s `createRenderer` directly with inert
 * no-op DOM ops. No DOM globals needed at all.
 *
 * Because Pinia caches store instances, this only has to happen once: every
 * `useXStore()` call anywhere else in the codebase after this module's
 * `mountHeadlessApp()` has run returns the already-built instance without
 * re-running `setup()`, so it never needs injection context again.
 *
 * The router is real (`vue-router`'s `createRouter`), not the plain-object
 * `router` singleton `server/src/shims/router.js` provides for direct
 * `import { router } from '../plugins/router'` call sites — those are two
 * different injection mechanisms and both are needed. Memory history and a
 * single catch-all route are enough: nothing server-side renders a matched
 * route (the catch-all exists only so the initial navigation has *something*
 * to match, silencing a startup warning), the stores that call
 * `router.push(...)` do it from inside
 * UI-event handlers, and `router.currentRoute` is a real ref either way.
 *
 * i18n is real (`vue-i18n`'s `createI18n`) for the same reason, with no
 * locale messages loaded — `missingWarn`/`fallbackWarn` off makes `t(key)`
 * return `key` verbatim by default, matching `server/src/shims/i18n.js`'s
 * plain-object behaviour for direct importers.
 *
 * `pinia` itself is imported from the real `src/stores/index.js` barrel
 * (which does `export const pinia = createPinia()` at module scope) rather
 * than created fresh here — the real `src/app.js` does the same, and a
 * second, unused `createPinia()` instance would just be a confusing extra
 * universe no code actually needs.
 */
// @vue/runtime-core avoids @vue/runtime-dom's window/SVGElement checks on
// purpose here; see the header above.
// eslint-disable-next-line vue/prefer-import-from-vue
import { createRenderer } from '@vue/runtime-core';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';

import {
    createGlobalStores,
    initPiniaPlugins,
    pinia
} from '../../src/stores/index.js';

/** Every DOM op this component could reach is a no-op — it never renders. */
const inertNodeOps = {
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
    querySelector: () => null,
    setScopeId() {},
    cloneNode: () => ({}),
    insertStaticContent: () => [null, null]
};

/** @type {{ app: import('vue').App, pinia: import('pinia').Pinia, router: import('vue-router').Router, i18n: ReturnType<typeof createI18n>, stores: ReturnType<typeof createGlobalStores> } | null} */
let instance = null;

/**
 * Idempotent — later callers get the same instance rather than a second app
 * (and a second `createGlobalStores()` call) quietly shadowing the first.
 */
export async function mountHeadlessApp() {
    if (instance) return instance;

    await initPiniaPlugins();

    const router = createRouter({
        history: createMemoryHistory(),
        // A catch-all, not a real route — nothing here ever renders one.
        // Memory history's initial navigation target has no match otherwise,
        // which vue-router logs as a startup warning on every boot.
        routes: [{ path: '/:pathMatch(.*)*', component: {} }]
    });
    const i18n = createI18n({
        legacy: false,
        locale: 'en',
        fallbackLocale: 'en',
        missingWarn: false,
        fallbackWarn: false,
        warnHtmlMessage: false
    });

    /** @type {ReturnType<typeof createGlobalStores> | undefined} */
    let stores;
    const { createApp } = createRenderer({
        ...inertNodeOps,
        patchProp() {}
    });
    const app = createApp({
        setup() {
            stores = createGlobalStores();
            return () => null;
        }
    });
    app.use(pinia).use(router).use(i18n);
    app.mount({});

    instance = { app, pinia, router, i18n, stores };
    return instance;
}
