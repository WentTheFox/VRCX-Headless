# Building the desktop client

The Electron desktop client (`client-desktop/**` + `src-electron/**`) never
opens `VRCX.sqlite3` or talks to VRChat directly — see
[`CLAUDE.md`](../CLAUDE.md)'s phase 5 write-up. It always connects to a
`serve` instance running elsewhere (Docker, another machine, or the same box
run manually — see [`server/README.md`](../server/README.md)). There is no
CI pipeline for this build yet (see "Not covered here" below), so this is
the manual sequence that produces one, traced from the upstream CI workflow
this fork hasn't adapted.

## Prerequisites

- .NET 10 SDK (`dotnet --version`)
- Node ≥ 24.15, `pnpm install --frozen-lockfile` already run at the repo root

## 1. Build the .NET side

This compiles `AppApiElectron`/`Discord`/`LogWatcher`/`AssetBundleManager`/
`AppApiVrElectron` — the real native-capability bindings phase 5 left
untouched (only `SQLite`/`WebApi` were dropped). Output goes to
`build/Electron/`, which the next step expects to already be there.

```bash
# x64
dotnet build 'Dotnet/VRCX-Electron.csproj' -p:Configuration=Release -p:WarningLevel=0 -p:Platform=x64 -p:PlatformTarget=x64 -p:RestorePackagesConfig=true -t:"Restore;Clean;Build" -m -a x64

# arm64, instead
dotnet build 'Dotnet/VRCX-Electron-arm64.csproj' -p:Configuration=Release -p:WarningLevel=0 -p:Platform=arm64 -p:PlatformTarget=arm64 -p:RestorePackagesConfig=true -t:"Restore;Clean;Build" -m -a arm64
```

## 2. Build the Vue app and package the Electron app

```bash
pnpm run prod-linux      # -> build/html (the real, unmodified Vue app, PLATFORM=linux)
pnpm run build-electron  # x64: downloads a self-contained .NET runtime, then electron-builder
# or, for arm64:
pnpm run build-electron-arm64
```

`build-electron`/`build-electron-arm64` also run
`src-electron/download-dotnet-runtime.js`, which needs network access —
it's a separate download from the `dotnet build` step above, not something
that step already produced. The result is an AppImage under `build/`
(`VRCX_<version>_x64.AppImage` or the arm64 equivalent).

## Windows

The `PLATFORM=linux` build flag is historical, not descriptive — it means
"the Electron client," as opposed to `PLATFORM=windows`'s **CefSharp**
client, not "runs only on Linux." The Electron shell and its headless-server
connection code are plain cross-platform Node/Chromium and run on Windows
the same way. Live-verified on Windows (2026-08-17): server connection
(including importing a self-signed CA cert from the connection screen, for
a server with an OS-trusted-but-not-Node-trusted cert — see `CLAUDE.md`'s
`vrcx-import-ca-cert` note if you hit `fetch failed` on a self-hosted
server), VRChat autodetect/launch, the `/api/stream` pipeline relay, and
local-machine polling (game running, SteamVR, GameLog tailing) all work —
see `CLAUDE.md`'s "Desktop client OS support" table (§1) for exactly which
native capabilities are and aren't OS-branched yet.

Steps 1–2 above are unchanged on Windows (`dotnet build` needs no
Windows-specific flags; `pnpm run prod-linux` still means "build for the
Electron client," not "for Linux"). Both the raw run and the packaged
installer are verified:

```powershell
pnpm run prod-linux
& .\node_modules\.bin\electron.exe .          # raw, unpacked run
pnpm run build-electron                        # packaged NSIS installer
& .\build\win-unpacked\VRCX.exe               # smoke-test the packaged app directly, same as CI does for the AppImage
```

`package.json`'s electron-builder config has no explicit `win` block (only
`linux`/`mac`) — turns out electron-builder's own built-in Windows defaults
(NSIS installer) are enough as-is, confirmed live (2026-08-17):
`build-electron` produced `build\VRCX Setup <version>.exe` and
`build\win-unpacked\VRCX.exe` unmodified, and the unpacked app launched
cleanly and picked up an already-paired session straight into the real app,
same as every other verified pass this session. `download-dotnet-runtime.js`
deliberately skips bundling a self-contained .NET runtime on Windows (it
only handles the `.tar.gz` distribution, not the Windows `.zip` one) — the
target machine needs .NET 10 installed already, same requirement `main.js`'s
own startup check already enforces.

Not yet done: an actual install-and-launch pass through the NSIS installer
itself (only the unpacked output has been smoke-tested), and no CI coverage
— `.github/workflows/client-desktop.yaml` still only builds/tests the Linux
AppImage.

## First run

There is no bundled server and no same-origin default — phase 5's "always
external" decision, made deliberately so the desktop client never manages a
server's lifecycle. The AppImage's first launch (or any launch without a
still-valid stored session) opens `client-desktop/setup.html` instead of the
real app. A stored session survives a `serve` restart on its own now, and
every successful launch rotates it into a fresh one with a full new expiry
(`/api/session/refresh`) — so this screen only reappears once the token is
genuinely gone: never paired, explicitly logged out, or not reopened for
longer than its 180-day window.

1. Enter the URL of a running `serve` instance.
2. If that server has never been paired with a TOTP secret yet, this page
   shows the same one-shot QR-code enrollment flow the web client's login
   gate uses (`client-web/bootstrap.js`) — scan it, confirm a code, and
   you're connected immediately. If it's already enrolled, just enter the
   current 6-digit code instead.

See `server/README.md`'s "TOTP setup" section for the server side of this
same flow, including how to reset it if you're locked out.

## Troubleshooting (Linux)

**The app crashes immediately, or the taskbar icon appears and disappears with no window ever showing up.** Two distinct, confirmed causes:

- **A GPU/Vulkan driver crash.** Some Linux graphics stacks crash Chromium's GPU process outright — under Wayland this shows as `'--ozone-platform=wayland' is not compatible with Vulkan` followed by repeated `GPU process launch failed` and a fatal `GPU process isn't usable. Goodbye.`; under X11 (e.g. after adding `--x11`) it can instead show as `GPU process exited unexpectedly` with a SIGSEGV. Run the AppImage from a terminal to see which one you're hitting. The fix is `--disable-gpu`, added either to the launch command directly or to your `.desktop` file's `Exec=` line (see below) — this forces software rendering and reliably avoids both crash modes. It's **not** applied by default: it's a driver-specific problem this fork has no way to detect, and forcing it on everyone would cost every working-GPU user their hardware acceleration for nothing.
- **A stale FUSE mount from a previous instance that was force-killed.** If a running instance is ever terminated with `kill -9` instead of a normal quit, the AppImage's FUSE mount can be left in a broken "Transport endpoint is not connected" state — every later launch (including a plain double-click) then fails silently, with nothing in any log. Check with `mount | grep AppImage`; a stale entry shows up there even though nothing is actually running. `fusermount -u <mount path>` (or `umount -l` as a fallback if that reports "not mounted") clears it — a normal, ungraceful `kill` (`SIGTERM`, not `-9`) doesn't have this problem, since the AppImage runtime gets a chance to unmount on its way out.

**A custom CA cert is imported (`vrcx-import-ca-cert`, for a self-signed `serve` instance) and the app intermittently produces no window and no logs at all on launch.** The self-relaunch that sets `NODE_EXTRA_CA_CERTS` for the imported cert (`customCaCertPath`'s own doc comment in `src-electron/main.js`) is known to be unreliable specifically in a *packaged* AppImage build — confirmed reproducible every time on at least one real machine, despite the identical code working fine in an unpackaged dev run; the packaged-vs-dev discrepancy itself hasn't been root-caused. A fresh install's `.desktop` file (or one refreshed by a later app launch, since this runs on every startup) now bakes the env var directly into `Exec=` instead, so that relaunch never has to fire for a desktop-icon launch — the self-relaunch itself is left in place as a fallback for any other launch path (a terminal, a file manager, `--startup`). An install whose `.desktop` file predates this fix can apply it by hand:

```
Exec=env NODE_EXTRA_CA_CERTS=<path-to-custom-ca.pem> <path-to-AppImage> --ozone-platform-hint=auto
```

(`custom-ca.pem` lives at `~/.config/VRCX/custom-ca.pem`; the `.desktop` file itself is normally at `~/.local/share/applications/VRCX-Headless.desktop`.) Combine with `--disable-gpu` too if you're also hitting the GPU crash above.

## CI

`.github/workflows/client-desktop.yaml` automates the sequence above on
every push/PR touching `client-desktop/**`, `src-electron/**`, `Dotnet/**`,
or `src/**`: builds the .NET side, the Vue app, and the AppImage, then boots
it under `xvfb-run` (via `--appimage-extract-and-run`, since FUSE isn't
guaranteed present) to confirm it doesn't crash on launch, and uploads the
AppImage as a workflow artifact. Deliberately narrower than
`.github/workflows/github_actions.yml` (upstream's own Windows/CefSharp +
Azure-signing release pipeline, untouched): x64 only, no code signing, no
publish step — this exists to catch build breaks early, not to ship
releases.

## CI (release)

`.github/workflows/desktop-release.yaml` is the actual release path, separate
from the build-verification CI above: triggered by the same `v*` tag push
that cuts a Docker release (CLAUDE.md's "Cutting a release"), it builds
Windows and Linux (x64+arm64) plus macOS (Apple Silicon only — Intel was
dropped after repeatedly failing to get a runner dispatched at all), self-
signs the Windows artifacts with the cert from
`build-scripts/generate-self-signed-certs.sh`, and attaches everything to a
**draft** GitHub Release — see CLAUDE.md's "Desktop client release
artifacts" for the full live-run history. Windows signing is confirmed
actually working (`signtool.exe` verified signing the real installer), and
Linux/Windows build mechanics are proven repeatable. macOS ships **unsigned**
deliberately — electron-builder's own preflight refuses any self-signed
identity outright (macOS flags it untrusted regardless of successful
keychain import), a genuine limitation with no config-level fix, not a bug
in this workflow. macOS's runner scheduling on this account has also been
unreliable — treat a stalled macOS leg as worth retrying, not a workflow
bug.

## Not covered here

- **Shrinking the bundled `.NET`/`node-api-dotnet` footprint.** Still fully
  justified as of phase 5 — `AppApiElectron`/`Discord`/`LogWatcher`/
  `AssetBundleManager`/`AppApiVrElectron` are all real, in-process .NET
  objects the renderer calls directly; only `SQLite`/`WebApi` were dropped.
- **A visible Discord Rich Presence end to end.** The agent-channel
  mechanism itself is live-verified (see `CLAUDE.md`'s phase 5 write-up) —
  real agent connection, real `Discord.SetActive` round-trip, no errors.
  What's unconfirmed is the actual presence display, which needs the
  account in a live VRChat world instance, not something a build/CI pass
  can produce on its own.
