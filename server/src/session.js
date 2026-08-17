/**
 * CLI-facing login/session orchestration over the real reactive stores —
 * phase 2b step 7. Replaces `server/src/vrchat.js`'s imperative
 * `VRChatSession`/`PipelineConnection` scaffold, which drove the four auth
 * endpoints and the pipeline connection directly because the store graph
 * couldn't load under Node yet. It can now (phase 2b steps 1-6), so this
 * drives the same real code the desktop client does: `src/stores/auth.js`,
 * `src/coordinators/userCoordinator.js`, `src/services/websocket.js`.
 *
 * The one thing a CLI has to do that a mounted `<App>` doesn't: none of
 * `login()`/`autoLoginAfterMounted()`/`handleCurrentUserUpdate()` resolve
 * when login actually *finishes* — 2FA (`promptTOTP` et al.) runs as an
 * un-awaited `.then()` chain off the initial `auth/user` request, so their
 * returned promises settle as soon as that first request completes, 2FA
 * needed or not. The real client doesn't care, because its UI just re-renders
 * whenever `watchState.isLoggedIn` flips reactively. A CLI has to explicitly
 * wait for that flip instead — `waitForLogin` below is that wait, via a
 * plain `watch()` outside any component (fine: this process exits when the
 * command is done, so there is nothing to leak).
 */
import { watch } from 'vue';

import { watchState } from '../../src/services/watchState.js';
import { wsState } from '../../src/services/websocket.js';
import { log } from './log.js';

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @param {string} timeoutMessage
 * @returns {Promise<void>}
 */
function waitUntil(predicate, timeoutMs, timeoutMessage) {
    if (predicate()) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            stop();
            reject(new Error(timeoutMessage));
        }, timeoutMs);
        const stop = watch(predicate, (done) => {
            if (!done) return;
            clearTimeout(timer);
            stop();
            resolve();
        });
    });
}

/**
 * Populates the real login form and drives the real `login()` flow,
 * including — via `server/src/shims/modal.js`'s `otpPrompt` — interactive
 * 2FA over stdin. Resolves once `watchState.isLoggedIn` actually flips, not
 * when `login()`'s own promise settles (see file header).
 *
 * @param {ReturnType<typeof import('../../src/stores/index.js').createGlobalStores>} stores
 * @param {{ username: string, password: string, endpoint?: string, websocket?: string }} params
 * @param {{ timeoutMs?: number }} [options] `timeoutMs` needs to cover
 *   interactive 2FA entry, not just network latency — defaults to 2 minutes.
 * @returns {Promise<any>} the logged-in user
 */
export async function loginWithCredentials(
    stores,
    { username, password, endpoint = '', websocket = '' },
    { timeoutMs = 120_000 } = {}
) {
    stores.auth.loginForm.value = {
        ...stores.auth.loginForm.value,
        username,
        password,
        endpoint,
        websocket,
        saveCredentials: true
    };
    await stores.auth.login();
    await waitUntil(
        () => watchState.isLoggedIn,
        timeoutMs,
        'Timed out waiting for login to complete (bad credentials, or 2FA never answered)'
    );
    return stores.user.currentUser;
}

/**
 * Restores a previously saved session (cookie + `savedCredentials`), the
 * same way the desktop app does on startup. Resolves `null` rather than
 * rejecting when there is nothing to restore — "not logged in" is an
 * expected outcome here, not a failure.
 *
 * @param {ReturnType<typeof import('../../src/stores/index.js').createGlobalStores>} stores
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any | null>}
 */
export async function restoreSession(stores, { timeoutMs = 30_000 } = {}) {
    await stores.auth.autoLoginAfterMounted();
    try {
        await waitUntil(
            () => watchState.isLoggedIn,
            timeoutMs,
            'Timed out waiting for session restore'
        );
    } catch {
        return null;
    }
    return stores.user.currentUser;
}

/**
 * `handleLogoutEvent()`, not the exported `logout()` — `logout()` shows a
 * confirm dialog first (`modalStore.confirm`, which
 * `server/src/shims/modal.js` always auto-declines, matching there being no
 * user), and would be a silent no-op through it. Running the `logout`
 * command *is* the confirmation.
 *
 * @param {ReturnType<typeof import('../../src/stores/index.js').createGlobalStores>} stores
 */
export async function logoutSession(stores) {
    await stores.auth.handleLogoutEvent();
}

/**
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
export function waitForPipelineConnected({ timeoutMs = 30_000 } = {}) {
    return waitUntil(
        () => wsState.connected,
        timeoutMs,
        'Timed out waiting for the pipeline to connect'
    );
}

const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];
const RETRY_STEADY_STATE_MS = 5 * 60_000;

/**
 * Keeps retrying `restoreSession()` in the background after `serve`'s own
 * one-shot boot attempt didn't resolve with a logged-in user.
 *
 * Without this, nothing anywhere ever promotes a `serve` process from
 * "never connected" to "connected" — verified by reading every call site
 * of `restoreSession`/`waitForPipelineConnected`/`updateLoop()`: both live
 * commands (`serve`, `pipeline`) call them exactly once, at boot, with no
 * retry path. `restoreSession()`'s own 30s timeout can't distinguish
 * "genuinely logged out" from "VRChat/the network wasn't ready yet" — and
 * a container that restarts automatically (e.g. on every push touching
 * its own compose/config files) can easily race a boot against a network
 * that isn't ready yet. Previously that needed a second manual restart to
 * recover; this self-heals instead.
 *
 * A no-op if there was never a saved session to restore in the first
 * place (`lastUserLoggedIn` unset) — that's `run login` territory, not
 * something retrying can fix, and retrying forever for an install that
 * was simply never logged in would just be background noise.
 *
 * @param {ReturnType<typeof import('../../src/stores/index.js').createGlobalStores>} stores
 * @param {import('./db.js').DatabaseHandle} handle
 * @param {object} [options] Test seams only — `serve` never passes this.
 *   Same "default parameter as injection point" pattern as
 *   `src/coordinators/authAutoLoginCoordinator.js`'s own `isOnline` option;
 *   there is no clean way to intercept a same-module function call
 *   (`restoreSession`, `waitForPipelineConnected`) from a test otherwise —
 *   real ESM bindings aren't mockable the way `module.exports` properties are.
 * @param {typeof restoreSession} [options.restoreSessionFn]
 * @param {typeof waitForPipelineConnected} [options.waitForPipelineConnectedFn]
 * @param {number[]} [options.retryDelaysMs]
 * @param {number} [options.steadyStateMs]
 * @returns {Promise<() => void>} stops the retry loop — `serve` itself
 *   never calls this (the loop is meant to run for the process's whole
 *   lifetime), it's there so tests can clean up fake timers deterministically
 */
export async function scheduleSessionRestoreRetries(
    stores,
    handle,
    {
        restoreSessionFn = restoreSession,
        waitForPipelineConnectedFn = waitForPipelineConnected,
        retryDelaysMs = RETRY_DELAYS_MS,
        steadyStateMs = RETRY_STEADY_STATE_MS
    } = {}
) {
    const lastUser = await handle.configRepository.getString(
        'lastUserLoggedIn',
        null
    );
    if (!lastUser) {
        return () => {};
    }

    let attempt = 0;
    let stopped = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;

    async function tick() {
        if (stopped) {
            return;
        }
        attempt += 1;
        const user = await restoreSessionFn(stores).catch(() => null);
        if (user?.id) {
            log.info('VRChat session restored after a retry', {
                attempts: attempt
            });
            await waitForPipelineConnectedFn().catch((err) => {
                log.warn(
                    'Pipeline did not connect after a session-restore retry',
                    {
                        message: err.message
                    }
                );
            });
            stores.updateLoop.updateLoop();
            return;
        }
        const delay = retryDelaysMs[attempt] ?? steadyStateMs;
        log.debug('VRChat session restore attempt failed, retrying', {
            attempt,
            nextAttemptInMs: delay
        });
        timer = setTimeout(tick, delay);
    }

    timer = setTimeout(tick, retryDelaysMs[0]);

    return () => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
        }
    };
}

export { watchState, wsState };
