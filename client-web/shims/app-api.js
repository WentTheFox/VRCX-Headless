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
    }
};

export const appApiTarget = new Proxy(IMPLEMENTED, {
    get(target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in target) return target[prop];
        return () => {
            throw new Error(
                `AppApi.${prop} is not available in the web client`
            );
        };
    }
});
