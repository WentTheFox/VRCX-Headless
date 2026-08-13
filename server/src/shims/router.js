/**
 * Headless stand-in for `src/plugins/router.js`.
 *
 * The real module imports every view `.vue` file directly to build its route
 * table — `.vue` files cannot even be parsed by Node's ESM loader, let alone
 * run, so that module can never load here. `src/stores/avatarProvider.js` and
 * `src/stores/gallery.js` import the `router` singleton by name (not via the
 * `useRouter()` composable) just to call `.push()` and read `.currentRoute`,
 * so that is the shape reproduced here.
 *
 * `useRouter()` itself (used in ~5 stores, e.g. `friend.js`, `charts.js`)
 * needs a real router installed on a mounted app for injection to resolve —
 * that is phase 2b step 5, not this one. Those calls fail only when the
 * store's setup function actually runs, not at import time, so they do not
 * block the module graph from loading.
 */
import { ref } from 'vue';

export const router = {
    currentRoute: ref({ name: null, path: '/', params: {}, query: {} }),
    push() {},
    replace() {}
};

export default router;
