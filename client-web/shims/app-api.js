/**
 * Client-side `window.AppApi` (phase 4) — the roadmap's "capabilities
 * gating". `Dotnet/AppApi/**` backs ~81 methods over CEF/Electron IPC;
 * `server/src/globals.js`'s server-side polyfill answers all of them with a
 * silent no-op, which is correct there (nobody's watching a headless
 * process). Here a human is looking at the screen, so the default flips:
 * anything not explicitly implemented below throws a clear error instead of
 * pretending to succeed, so a UI handler can catch it and disable/hide the
 * control rather than silently do nothing.
 *
 * Only the trivial, genuinely web-appropriate subset is implemented for
 * real in this first slice — the ~35+ desktop-only methods actually called
 * from `src/**` (VR overlay, Discord RPC, registry, screenshots, game
 * launch, log watching, `CopyImageToClipboard(path)` — a *file path* the
 * browser has no access to) are out of scope here; expanding capability
 * coverage is explicit follow-up work, not a gap to paper over.
 */
import { toast } from 'vue-sonner';

const IMPLEMENTED = {
    async GetVersion() {
        return VERSION;
    },
    async SetUserAgent() {
        // No-op: the real User-Agent is set server-side
        // (server/src/globals.js's buildUserAgent) on every proxied request.
    },
    async GetClipboard() {
        return navigator.clipboard.readText();
    },
    // The four below are called unconditionally during app boot
    // (src/plugins/ui.js's initUi(), src/stores/ui.js's setup) rather than
    // from a user-triggered UI action — found live, not by inspection: the
    // throw-by-default design is correct for a button click a component can
    // catch, but an uncaught throw/rejection here happens before anything
    // ever renders, leaving #root permanently empty. ChangeTheme/
    // SetTrayIconNotification are native window-chrome/tray concerns with
    // no browser-tab equivalent, so a no-op is the correct behaviour, not a
    // stand-in. CustomCss/CustomScript read a local custom.css/custom.js
    // file (Dotnet/AppApi/Common/AppApiCommon.cs) that has no browser
    // analogue either; returning '' matches what native already returns
    // when no such file exists, which is the common case.
    async ChangeTheme() {},
    async SetTrayIconNotification() {},
    async CustomCss() {
        return '';
    },
    async CustomScript() {
        return '';
    },
    // Found live: these five fire not just once at boot but on a
    // recurring ~60s cycle alongside a language/settings sync (each
    // producing its own uncaught rejection, spamming the console
    // indefinitely) — worse than the one-shot boot case above, and still
    // not a user-triggered action a component could catch. Registry/VR
    // overlay/launcher settings/image-host population are all
    // desktop-only concepts with no browser equivalent, so a no-op or an
    // empty/false "nothing here" answer is the correct steady-state
    // response, not a stand-in for a missing capability.
    async ExecuteVrOverlayFunction() {},
    async SetAppLauncherSettings() {},
    async PopulateImageHosts() {},
    async GetVRChatRegistryKey() {
        return null;
    },
    async HasVRChatRegistryFolder() {
        return false;
    },
    // Found live, same unconditional-on-every-profile-open shape as
    // SendIpc below: native (Dotnet/AppApi/Common/LocalPlayerModerations.cs)
    // reads a local VRChat game client file
    // (LocalPlayerModerations\{id}-show-hide-user.vrcset) a browser has no
    // access to, returning 0 ("no local moderation set") whenever that file
    // or the entry in it is missing — which is every browser session, by
    // definition. 0 is that same "nothing here" default, not a stand-in.
    // (SetVRChatUserModeration, the write half, is left to throw — it's a
    // user-triggered hide/show-avatar button click, not called
    // unconditionally, so the existing throw-and-let-a-handler-catch-it
    // default is correct for it.)
    async GetVRChatUserModeration() {
        return 0;
    },
    // Native reads .NET's CultureInfo.CurrentCulture (falling back to
    // "en-US"); navigator.language is the direct browser equivalent, not
    // a stand-in — a genuinely better answer here than a hardcoded value.
    async CurrentCulture() {
        return navigator.language || 'en-US';
    },
    // Found live, same recurring-cycle pattern as the five above.
    // GetLaunchCommand reads a `vrcx://` deep-link argument captured at
    // native process startup — no browser equivalent, '' matches native's
    // own "nothing queued" default. IPCAnnounceStart tells other native
    // instances this one started — no-op, no such concept in a browser
    // tab. CheckGameRunning polls a native process list — no-op, same as
    // IsGameRunning/IsSteamVRRunning are already required to be inert
    // server-side. GetZoom's own real Electron implementation
    // (Dotnet/AppApi/Electron/AppApiElectron.cs) just hardcodes `return 1`
    // regardless of actual window state, so this isn't a stand-in either.
    async GetLaunchCommand() {
        return '';
    },
    async IPCAnnounceStart() {},
    async CheckGameRunning() {},
    async GetZoom() {
        return 1;
    },
    // Found live: called unconditionally, synchronously, at the very start
    // of every showUserDialog() (src/coordinators/userCoordinator.js) —
    // opening *any* user's profile. Unlike a user-triggered button a
    // component can wrap in try/catch, this Proxy's default throw isn't
    // caught anywhere on that call path, so it aborted the rest of the
    // (synchronous) function before the actual queryRequest.fetch('user',
    // ...) a few lines down ever ran — every profile dialog opened stuck on
    // "loading" forever with placeholder data. Native SendIpc
    // (Dotnet/AppApi/Common/AppApiCommon.cs) just broadcasts a message to
    // other native VRCX instances over an IPC server — the same
    // no-other-instances-to-notify reasoning as the already-no-op
    // IPCAnnounceStart above, not a stand-in for a missing capability.
    async SendIpc() {}
};

export const appApiTarget = new Proxy(IMPLEMENTED, {
    get(target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        return () => {
            const message = `AppApi.${prop} is not available in the web client`;
            // Toasted here, at the throw site, rather than relying only on
            // the generic unhandledrejection listener (src/plugins/
            // interopApi.js, phase 6): that one only catches rejections
            // nothing ever handles. A call site with its own .catch()/
            // try-catch that just console.errors and moves on (several do —
            // this Proxy's own header comment assumes a "UI handler can
            // catch it and disable/hide the control", which several call
            // sites don't actually do) would otherwise fail completely
            // silently from the user's point of view. Throwing after the
            // toast preserves the original catch/no-op behaviour for
            // whatever a call site already does with it.
            toast.error(message);
            const error = new Error(message);
            // Tells installUnhandledRejectionReporting (src/plugins/
            // interopApi.js) not to toast this one a second time if it also
            // turns out to be unhandled — found live: an unwrapped `await
            // AppApi.X()` with no local catch reaches BOTH this throw site
            // AND the window's unhandledrejection event, producing two
            // toasts for one failure without this flag.
            error['alreadyToasted'] = true;
            throw error;
        };
    }
});
