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
- Node ≥ 24.15, `npm ci` already run at the repo root

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
npm run prod-linux      # -> build/html (the real, unmodified Vue app, PLATFORM=linux)
npm run build-electron  # x64: downloads a self-contained .NET runtime, then electron-builder
# or, for arm64:
npm run build-electron-arm64
```

`build-electron`/`build-electron-arm64` also run
`src-electron/download-dotnet-runtime.js`, which needs network access —
it's a separate download from the `dotnet build` step above, not something
that step already produced. The result is an AppImage under `build/`
(`VRCX_<version>_x64.AppImage` or the arm64 equivalent).

## First run

There is no bundled server and no same-origin default — phase 5's "always
external" decision, made deliberately so the desktop client never manages a
server's lifecycle. The AppImage's first launch (or any launch without a
still-valid stored session — sessions are process-lifetime only on the
server side, so this includes every restart of `serve`) opens
`client-desktop/setup.html` instead of the real app:

1. Enter the URL of a running `serve` instance.
2. If that server has never been paired with a TOTP secret yet, this page
   shows the same one-shot QR-code enrollment flow the web client's login
   gate uses (`client-web/bootstrap.js`) — scan it, confirm a code, and
   you're connected immediately. If it's already enrolled, just enter the
   current 6-digit code instead.

See `server/README.md`'s "TOTP setup" section for the server side of this
same flow, including how to reset it if you're locked out.

## Not covered here

Traced but deliberately not attempted, since this sandbox has no working
`dotnet`/Electron toolchain to build and verify either against (confirmed:
`dotnet` is not installed here):

- **A fork-adapted CI workflow.** `.github/workflows/github_actions.yml` is
  still upstream's own Windows/CefSharp + Azure-signing pipeline, untouched.
  The sequence above is what a Linux-only equivalent would need to
  automate, but writing that workflow blind, with no way to run it, isn't
  something this fork claims as done.
- **Shrinking the bundled `.NET`/`node-api-dotnet` footprint.** Still fully
  justified as of phase 5 — `AppApiElectron`/`Discord`/`LogWatcher`/
  `AssetBundleManager`/`AppApiVrElectron` are all real, in-process .NET
  objects the renderer calls directly; only `SQLite`/`WebApi` were dropped.
  Reducing that footprint further needs the same real build environment.
