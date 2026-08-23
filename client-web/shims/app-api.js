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
 * from `src/**` (VR overlay, Discord RPC, registry, screenshots, log
 * watching, `CopyImageToClipboard(path)` — a *file path* the browser has no
 * access to) are out of scope here; expanding capability coverage is
 * explicit follow-up work, not a gap to paper over. `StartGame`/
 * `StartGameFromPath` are the one exception, given a best-effort
 * `vrchat://` deep-link implementation below rather than left to throw —
 * see that method's own comment.
 */
import { toast } from 'vue-sonner';

const IMPLEMENTED = {
    async GetVersion() {
        // `VERSION` is Vite's compile-time global — upstream's own date-only
        // `Version` file, with no fork branding or fork release counter.
        // Label it here so the web client doesn't read as a plain upstream
        // VRCX build; the raw value is still available separately as
        // vrcxUpdaterStore's `upstreamVersion` ("Based on VRCX version" in
        // Settings).
        return `VRCX Headless ${VERSION}`;
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
    // Found live: Login.vue's own login-screen language auto-detect
    // catches this (no crash, no toast — just a console error and the
    // prompt silently never offering to switch), but it's the same real
    // browser equivalent as CurrentCulture above, just a distinct native
    // method (BCP-47 from a different underlying .NET API) with its own
    // call site — not a fix for CurrentCulture, an addition alongside it.
    async CurrentLanguage() {
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
    async SendIpc() {},
    // Found live: the web client has no way to detect or launch a local
    // VRChat install, but the same `vrchat://launch` deep link vrchat.com's
    // own "Launch" button uses still works through the OS protocol handler
    // when VRChat/Steam is installed locally — `src/stores/launch.js`'s
    // `getLaunchUrl()` (unmodified, upstream-owned) already builds exactly
    // that URL for every launch, platform-agnostic. `args` here is that
    // file's own `[launchUrl, launchArguments, '--no-vr'].join(' ')`; only
    // the URL — always the first, space-free token — is usable through a
    // protocol handler, so custom launch arguments and forcing desktop mode
    // are silently dropped rather than attempted (VRChat/Steam's own
    // handler decides VR-vs-desktop on launch, same as clicking the website
    // button does). Native `StartGame` autodetects the VRChat install to
    // shell out to; a browser has no such capability, so this is the whole
    // of the fallback rather than a smaller piece of a larger one.
    async StartGame(args) {
        const launchUrl = args?.split(' ')[0];
        if (!launchUrl?.startsWith('vrchat://')) {
            throw new Error('No launch URL to open');
        }
        window.location.href = launchUrl;
        return true;
    },
    // A custom VRChat path override (native `StartGameFromPath`'s whole
    // reason to exist) means nothing to a browser, which can't launch an
    // arbitrary local path either way — same deep-link fallback as
    // StartGame above, just ignoring the path.
    async StartGameFromPath(_path, args) {
        return IMPLEMENTED.StartGame(args);
    },
    // Found live: called synchronously, unawaited, at the top of
    // promptTOTP()/promptEmailOTP() (src/stores/auth.js) — the *whole*
    // 2FA login flow, not just this one call. The Proxy's default fallback
    // throws synchronously (it's not an async function), so with no entry
    // here that throw aborted promptTOTP() before
    // `twoFactorAuthDialogVisible.value = true` ever ran: any VRChat
    // account with 2FA enabled couldn't log in via the web client at all.
    // Same "native window-chrome concern, no browser-tab equivalent" as
    // SetTrayIconNotification above — a no-op is the correct behaviour,
    // not a stand-in for a missing capability, but unlike that one this
    // was blocking a core flow rather than a background hint.
    async FlashWindow() {}
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
