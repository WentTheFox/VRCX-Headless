/**
 * The OS the app is actually running on, as opposed to the `LINUX`/`WINDOWS`
 * build flags, which only name the *shell*: `WINDOWS` is the CefSharp build
 * (always Windows), `LINUX` is the Electron build, which runs on Linux,
 * Windows and macOS alike. Use these for anything that depends on the host
 * OS (registry, autostart, Windows-only third-party apps, file paths), and
 * the build flags for anything that depends on which shell/bridge exists.
 *
 * Fork-owned (VRCX-Headless); see CLAUDE.md §1, "Build flags are not OS
 * flags". Read at call time, so tests can stub `navigator.platform`, and
 * safe under Node (the headless server), where they all return false unless
 * Node's own `navigator` says otherwise.
 */
function platform() {
    return typeof navigator === 'undefined' ? '' : String(navigator.platform || '').toLowerCase();
}

export function isHostWindows() {
    return platform().startsWith('win');
}

export function isHostMacOS() {
    return platform().includes('mac');
}

export function isHostLinux() {
    return platform().includes('linux');
}
