# VRCX-Headless — fork architecture and upstream migration guide

This fork splits [VRCX](https://github.com/vrcx-team/VRCX) into two pieces:

- a **headless server** that owns the VRChat API connection and is the *sole writer* of `VRCX.sqlite3`
- a **client** — the existing Vue app — that runs either in a browser or inside the Electron desktop shell, and stays in sync across devices off a server event stream

Upstream is a fast-moving, UI-heavy project, and `.github/CONTRIBUTING.md` says UI PRs are declined there, so **everything we diverge on is permanently ours to maintain**. This document exists to make each upstream merge mechanical rather than archaeological.

**Layout of this guide:** §1–§4, §6–§8 live here; the big reference sections are split out and loaded on demand — §5 → [`docs/patch-inventory.md`](docs/patch-inventory.md), §9 → [`docs/known-limitations.md`](docs/known-limitations.md), §10 → [`docs/release.md`](docs/release.md). Section numbers are stable, so `§5`/`§9`/`§10` references anywhere still resolve.

**If you are an agent or contributor about to change something: read "Invariants" first. They are the whole reason this fork is maintainable.**

**Status:** fully implemented — server, web client, desktop client, TOTP auth, cross-platform desktop releases (§10). §9 lists what's a deliberate scope cut, not unfinished work. §2–§6 are the merge mechanics; §8 is a one-line-per-phase summary, not a build history.

---

## 1. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │  server/   (Node, headless)               │
                    │  ── sole owner of VRCX.sqlite3 ──         │
                    │  • runs src/services/database/** verbatim │
                    │  • VRChat REST  (undici + tough-cookie)   │
                    │  • VRChat pipeline WebSocket              │
                    │  • updateLoop daemon + bg coordinators    │
                    │  • HTTP RPC + WS fan-out, TOTP auth        │
                    └──────────────────────────────────────────┘
                        ▲  client channel        ▲  agent channel
                        │  (RPC + state stream)  │  (logs up, commands down)
        ┌───────────────┴──────────┐   ┌─────────┴───────────────────────┐
        │ Browser client           │   │ Desktop client (Electron)       │
        │ PLATFORM=web             │   │ PLATFORM=windows|linux          │
        │ no native, no SQL        │   │ + .NET sidecar: LogWatcher,     │
        │                          │   │   VR overlay, Discord, registry │
        └──────────────────────────┘   └─────────────────────────────────┘
```

### Desktop client OS support

The `PLATFORM` build flag names are historical, not descriptive: `PLATFORM=windows` builds the **CefSharp** client (upstream's original native-Windows shell, `Dotnet/AppApi/Cef/**`) — it does not run on Linux. `PLATFORM=linux` builds the **Electron** client (`Dotnet/AppApi/Electron/**`, `Dotnet/VRCX-Electron.csproj`) — despite the flag name, the Electron *shell* itself and its headless-server connection code (phase 5) are plain cross-platform Node/Chromium and run fine on Windows too, unlike CefSharp which only runs on Windows.

What's actually OS-tested inside `Dotnet/AppApi/Electron/**`, verified live (2026-08-17, Windows, against a self-hosted server with a step-ca-issued cert):

| Capability | Linux | Windows |
|---|---|---|
| Server connection, RPC, agent channel, TLS/CA trust | tested (AppImage, phase 5) | tested |
| `StartGame`/`StartGameFromPath` (VRChat autodetect + launch) | tested (Steam-on-Linux paths) | tested (Steam/VRChat registry keys, `GameHandler.cs`'s `StartGameWindows`/`StartGameFromPathWindows`) |
| Everything else in `Folders.cs` (screenshot/app-data/crash paths, `OpenFolderAndSelectItem`'s `xdg-open`/`nautilus`/etc, `which`-based command detection) | tested | **untested, almost certainly broken** — written entirely around Linux paths and Linux-only shell commands, no Windows branch added |
| `TryOpenInstanceInVrc` (attach a deeplink to an already-running client) | tested (`nsenter`+`wine`) | **untested, almost certainly broken** — same reason; the JS caller already has a self-invite fallback for exactly this failure mode, so it degrades gracefully rather than erroring |
| VR overlay, Discord RPC, LogWatcher, registry, screenshots | Linux-tested only | untested |

So: **Windows is a supported OS for the Electron client's server-connection and game-launch path specifically**, not a general Windows/Electron parity claim — the rest of the native surface should be assumed Linux-only until someone does the same OS-branching `GameHandler.cs` just got.

### Gotcha: build flags are not OS flags

The `LINUX`/`WINDOWS` compile-time globals (`src/vite.config.js`'s `define`) name the **shell**, not the host OS. `LINUX === true` in *every* Electron build, including the Windows `.exe` and macOS `.dmg` that `desktop-release.yaml` produces (all built with `pnpm run prod-linux`). `WINDOWS === true` only in the CefSharp build, which this fork doesn't ship. The naming is upstream's: upstream only shipped Electron for Linux, so for upstream "Electron" and "Linux" meant the same thing.

Most of upstream's `LINUX` checks really do mean "the Electron shell" (use `window.electron`/`InteropApi` rather than CefSharp, the Electron-only AppApi variants, and so on), and those are correct as they are. Don't rename them, because every upstream sync would then conflict on them. The bug class to watch for is a `LINUX`/`!isLinux` check that actually means **"is the host OS Linux/Windows"**: a registry, autostart or Windows-path feature, or a Windows-only third-party app such as XSOverlay or OVR Toolkit. On the Windows Electron build, those checks silently hide working features or show broken ones.

For host-OS checks use `src/shared/utils/hostOs.js` (`isHostWindows()`/`isHostLinux()`/`isHostMacOS()`, which read `navigator.platform` at call time). The pattern for "Windows-only feature" is `!LINUX || isHostWindows()`: CefSharp is always Windows, and Electron needs a runtime check. It also keeps upstream's tests, which toggle `globalThis.LINUX`, valid. Fixed so far: the startup toggles (`SystemTab.vue`), the launch-path override (`launch.js`/`LaunchOptionsDialog.vue`) and the XSOverlay/OVR Toolkit toggles (`VrTab.vue`). All are in §5.

### Who owns what

| Concern | Owner | Notes |
|---|---|---|
| `VRCX.sqlite3` (read + write) | **server** | The .NET side stops opening it entirely |
| VRChat REST API + cookie jar | **server** | Credentials never reach a client |
| VRChat pipeline WebSocket | **server** | Frames re-broadcast to clients verbatim |
| Polling daemon (`updateLoop`) | **server** | Runs once, not once per client |
| Settings (`configRepository`) | **server** | Shared across devices; small device-local allowlist |
| Rendering, dialogs, search, dashboards | **client** | |
| Game log tailing, VR overlay, Discord RPC, registry, screenshots, game launch | **desktop client** | Machine-local capabilities, provided to the server over the agent channel |
| `VRCXStorage` (`VRCX.json`) | **desktop client** | Genuinely machine-local (window geometry etc.) |

### Repository layout

| Path | Origin | Rule |
|---|---|---|
| `src/**` | upstream | **Mirrors upstream.** Changes here are a last resort and must be logged in §5. |
| `Dotnet/**`, `src-electron/**` | upstream | Same rule. |
| `server/**` | ours | The headless server. Setup docs: `server/README.md`. |
| `client-web/**` | ours | Browser-client shims. |
| `client-desktop/**` | ours | Desktop-agent shims + server-connection gate. Build docs: `client-desktop/README.md`. |
| `.github/workflows/server-docker.yaml`, `.dockerignore` | ours | Container build. New files, so no merge surface. |
| `CLAUDE.md` | ours | This file. |

---

## 2. Invariants

These six rules are what keep upstream merges cheap. Breaking one does not fail a test — it fails the *next* merge, expensively.

1. **Never edit a call site to accomplish the split.** Do not touch the 206 `database.*`, ~540 `configRepository.*`, or 115 `AppApi.*` call sites. Replace what sits *behind* them.
2. **Prefer aliasing over editing.** Server-side substitutions go in `server/aliases.js`; client-side ones in the Vite alias map under `PLATFORM=web`. An alias survives an upstream refactor of the module that imports it; an edit does not.
3. **Alias the smallest module that pulls in the unwanted dependency**, not the biggest one you can get away with. A stub that grows features is a fork in disguise.
4. **Keep public signatures byte-identical.** `configRepository.getString(key, default)`, the `database` method names, the `window.SQLite` contract — if these drift, every upstream PR touching settings or the DB conflicts.
5. **Additive, not subtractive.** Add a `PLATFORM=web` branch beside the existing `WINDOWS`/`LINUX` branches; do not restructure them.
6. **Every unavoidable `src/` edit gets an entry in §5**, with enough anchor context to re-find it after upstream reformats the file.

---

## 3. How the server runs upstream code unmodified

The server imports VRCX's *real* data layer. Nothing is copied or vendored.

### 3.1 Module resolution (`server/hooks.mjs`)

A Node ESM `resolve` hook (registered by `server/register-hooks.mjs`) emulates Vite's resolver — `src/**` uses extensionless and directory imports plain Node rejects, so the hook tries the exact path, then `.js`/`.mjs`/`.json`/`.ts`, then `index.js`/`index.mjs`/`index.ts` — and applies two alias maps from `server/aliases.js`: `aliases` (keyed by *resolved absolute path*, robust to however a module spells its import) and `packageAliases` (keyed by bare npm specifier, for packages that can't run under Node at all, matched before path resolution). It also forces `format: 'module'` for `src/**`, since the root `package.json` has no `"type": "module"`. Upstream has been migrating `src/api/**` from `.js` to `.ts` (2026-10-10 onward), so `.ts` targets get `format: 'module-typescript'` instead, letting Node 24's built-in type stripping erase the annotations; that only handles *erasable* syntax, so an `enum`/`namespace` in an upstream `.ts` file would be a new merge task (§6.2).

Vitest has its own module pipeline and never sees this hook, so `server/vite-alias-plugin.js` re-implements the same logic as a Vite plugin, reading the same `server/aliases.js` — the two paths cannot drift.

### 3.2 Compile-time globals (`server/src/globals.js`)

Vite's `define` block (`src/vite.config.js`) replaces `LINUX`, `WINDOWS`, `VERSION`, `NIGHTLY` at build time; under Node they're installed as real globals, both platform flags **false** (the server is neither the CEF/Windows nor the Electron/Linux build), plus `window` (see §3.7) so `window.X = Y` assignments work. Also installs a `CloseEvent` polyfill — `src/services/websocket.js:118` constructs one in its `onerror` handler to schedule reconnects, and Node has `WebSocket` but not `CloseEvent`.

### 3.3 The SQLite shim (`server/src/shims/sqlite.js`)

A behavioural port of `Dotnet/SQLite.cs` onto `node:sqlite`, covered by `server/test/sqlite-shim.test.js`:

| Requirement | Why | Mechanism |
|---|---|---|
| Rows are **positional arrays** | Every caller indexes `row[0]`, `row[1]`; object rows would collapse duplicate join column names | `statement.setReturnArrays(true)` |
| **Unknown named parameters are ignored** | System.Data.SQLite accepts params a statement never references; `node:sqlite` throws | `statement.setAllowUnknownNamedParameters(true)` |
| **Error text is SQLite's own** | `handleSQLiteError` in `src/services/sqlite.js` string-matches driver error text | no wrapping of driver errors |

Plus parameter coercion (`coerceParameter()`): `undefined`→null, `boolean`→0/1, `Date`→`toJSON()`, throws on anything else. Connection PRAGMAs mirror `Dotnet/SQLite.cs:37`: `locking_mode=NORMAL`, `busy_timeout=5000`, `journal_mode=WAL`.

### 3.4 Database location (`server/src/paths.js`)

Same resolution order as the desktop app: `VRCX_DATABASE` env var → `VRCX_DatabaseLocation` in `VRCX.json` → `<appdata>/VRCX/VRCX.sqlite3` (`%APPDATA%`/`$XDG_CONFIG_HOME`/`~/.config`, matching .NET's `SpecialFolder.ApplicationData`).

### 3.5 The WebApi shim (`server/src/shims/webapi.js`)

A behavioural port of `Dotnet/WebApi.cs` onto Node's global `fetch`, covered by `server/test/webapi-shim.test.js`. `src/services/webapi.js` is the only consumer, unmodified.

| Requirement | Why |
|---|---|
| `Execute` returns `{Item1, Item2}` and **never throws** | `webapi.js:37` reads the tuple; failures are `Item1 === -1` with the message in `Item2` |
| On failure the thrown value must be a **string** | `webapi.js:39` does `throw item.Item2`; `$throw` (`request.js:346`) `JSON.stringify`s anything that isn't already a string — an `Error` collapses to `{}` |
| Binary responses return `` `data:image/png;base64,…` `` | `WebApi.cs:468` hardcodes that prefix regardless of real content type |
| `Content-Type` on the body, `Referer` is a real referrer, User-Agent is `VRCX <version>`/`VRCX Nightly <version>` | `WebApi.cs`/`Program.cs`; VRChat rate-limits generic agents |
| Redirects are followed **by hand** | so the cookie jar applies on every hop, as `CookieContainer` does natively |

Uploads (`uploadImage*`, `uploadFilePUT`) return a clear "not supported" error — no server-side call site reaches them yet. Proxy support is `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`.

### 3.6 Cookies (`server/src/cookies.js`)

`tough-cookie` for the jar, persisted in **`Dotnet/WebApi.cs`'s exact format** so the same `VRCX.sqlite3` stays readable by the desktop app: base64 JSON array of `System.Net.Cookie`-shaped (PascalCase) objects, one row in `cookies` keyed `'default'`. Two easy-to-drop details: the `cookies` table is created by the shim too (the C# side creates it, not the JS migration layer), and every cookie expiry is forced to `DateTime.MaxValue` so sessions survive a restart, matching `WebApi.cs:204`.

### 3.7 Node's missing — or browser-different — globals

Missing entirely, all polyfilled in `server/src/globals.js` unless noted:

| Missing | Where it bites | Handling |
|---|---|---|
| `CloseEvent` | `websocket.js:118` reconnect | see §3.2 |
| `Worker` | `worker-timers` builds its timer from a blob-URL Worker — fails on first call, not import | `packageAliases` → `server/src/shims/worker-timers.js` |
| `navigator.onLine` | `authAutoLoginCoordinator.js:14` → falsy → permanent "you're offline" | inject `() => true` |
| `speechSynthesis` | `settings/notifications.js` TTS | stub (`getVoices`/`cancel`/`speak`) — stays a stub permanently, see §9 |
| `AppApi` | ~81 methods, bare global across `src/**` | `Proxy` (`installAppApiPolyfill`) — logged no-op for anything unlisted; `GetVersion()` returns the real `VERSION` |
| `VRCXStorage` | Explicitly desktop-owned (§1), but referenced as a bare global from several stores anyway | in-memory, process-lifetime `Map`-backed stub |
| `document` | `documentElement.classList`/`getElementById`/`querySelector(All)`/`createElement` from a bounded set of stores | polyfilled; `createElement` exists only because `@vue/runtime-dom` feature-checks it at module scope |
| `history` | Not `src/**` — vue-router's own `finalizeNavigation` reads `history.state`, guarded by an `isBrowser` check that the `document` polyfill above accidentally makes true | polyfilled (`installHistoryPolyfill`) — `mountHeadlessApp()` uses `createMemoryHistory()`, so only `.state` is a real read |

Present, but behaving differently:

| Present but different | Where it bites | Handling |
|---|---|---|
| `WebSocket` sends no default `User-Agent` | Cloudflare in front of `pipeline.vrchat.cloud` silently drops the handshake without one — immediate `onerror` + 1006 close, endless reconnect loop | global `WebSocket` wrap (`installWebSocketUserAgentPolyfill`) patching the zero-options call shape only |
| `window` is `globalThis` | Would defeat `@tanstack/query-core`/`@vueuse/core`'s SSR guards (`typeof window !== 'undefined'`) if aliased directly | `Proxy`: narrow real reads (`matchMedia`, `crypto`), but every `window.X = Y` write mirrors onto `globalThis[X]` too, since several `src/**` files read those as bare identifiers elsewhere |

### 3.8 Schema version

`server/src/db.js` **reads the target version out of `src/stores/vrcx.js`** with a regex rather than duplicating the constant. If the regex stops matching, it logs a warning and falls back to 16 — treat that warning as a merge task.

---

## 4. Seam table

The modules where the split happens. On an upstream merge, these are what to inspect.

| Seam | Upstream file | Width | Server side | Web client | Desktop client |
|---|---|---|---|---|---|
| SQL transport | `src/services/sqlite.js` | 2 methods; the **only** `window.SQLite` caller | real `node:sqlite` via `server/src/shims/sqlite.js` | unused once DB/config are aliased away (verified: no `SQLite.Execute`/`handleSQLiteError` in the built client) | same, verified in `pnpm run prod-linux` output |
| DB repository | `src/services/database/index.js` | flat ~190-method facade, 206 call sites | imported unmodified, but `server/src/feed-dedup.js` wraps the 5 `feed.js` write methods (`addGPSToDatabase`/`addStatusToDatabase`/`addAvatarToDatabase`/`addBioToDatabase`/`addOnlineOfflineToDatabase`) with a near-duplicate check — see that file's own doc comment for why | `Proxy` → `rpc('db', name, args)`, `client-web/shims/database.js` — except a small `pipelineOnlyWrites` allowlist (currently just `addOnlineOfflineToDatabase`) that no-ops instead of proxying, since the server's own pipeline processing already performs that exact write; see that file's own doc comment | same shape over IPC instead of `fetch`, `client-desktop/shims/database.js`, same `pipelineOnlyWrites` allowlist |
| Config KV | `src/services/config.js` | 13 methods, ~540 call sites | imported unmodified | RPC + write-through cache, `client-web/shims/config.js` | same, `client-desktop/shims/config.js` |
| VRChat HTTP | `src/services/webapi.js` | 4 methods; the **only** `window.WebApi` caller | `fetch` + tough-cookie via `server/src/shims/webapi.js` | proxied via server (`rpc.js`'s `webapi` target), `client-web/shims/webapi-target.js` | same target, `client-desktop/shims/webapi-target.js` |
| Pipeline WS | `src/services/websocket.js` | `handlePipeline` switch | runs unmodified | subscribes to server's `/api/stream` via an `AppDebug.websocketDomain` override (`client-web/bootstrap.js`), calls the same `handlePipeline` unmodified | same relay, different transport: `client-desktop/shims/pipeline-relay.js` overrides `AppDebug.websocketDomain` to a sentinel and swaps `window.WebSocket` for a relayed object, since the renderer has no session cookie for the server's origin and a raw `new WebSocket()` can't carry the `Authorization` header `/api/stream` needs — the real connection is opened in `src-electron/main.js` (`vrcx-stream-connect`, alongside the existing agent-channel socket) and every frame forwarded over IPC. Originally left as a direct renderer→VRChat connection (below); found live (2026-08-17) that this raced the server's own pipeline connection for the same account's `/auth` token, intermittently invalidating one or the other with a real "authToken doesn't correspond with an active session" pipeline error — routing through the server's single connection removes the second, competing one entirely |
| Daemon | `src/stores/updateLoop.js` | counter loop, ticks every 1000ms | runs the VRChat-API-polling half here, and only here | no-op store, `client-web/shims/update-loop.js` — a browser tab has no local-machine capability to poll either | mostly a no-op like web (VRChat-API polling stays server-only), but `client-desktop/shims/update-loop.js` runs its own real 1000ms loop for the four *local-machine* checks the real file gates on `if (LINUX && ...)` — `AppApi.IsGameRunning`/`IsSteamVRRunning`, `LogWatcher.GetLogLines`, `vrStore.vrInit()` — since those can't run server-side either (the server's own `LINUX` is `false`) and this client already has direct native access to them |
| Native globals | `src/plugins/interopApi.js` | 42 lines; the **only** injection point | n/a | third `WEB` branch, installs `client-web/shims/{webapi-target,app-api,vrcx-storage,log-watcher}.js` | existing Electron branch: `WebApi` swapped for the RPC target, `SQLite` no longer installed, `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager` stay the real `InteropApi.*` objects |
| Native capabilities → server | `Dotnet/AppApi/**`, `LogWatcher.cs`, `Discord.cs`, `AssetBundleManager.cs` | ~93 methods across 4 globals, all desktop-only | agent-aware `Proxy` polyfills (`server/src/globals.js`) — forward to a connected agent, else no-op | n/a — the browser has none of these capabilities | `server/src/agent.js` ↔ `/api/agent` WS ↔ the same `interopApi.callMethod` the renderer's own native calls already use |

### Current alias map (`server/aliases.js`)

`src/stores/index.js` (the barrel) is **not** aliased — it's imported for real. Everything below is the specific pieces of its closure that can't run under Node; `server/aliases.js`'s own comments are the source of truth if this table and the code disagree.

| Aliased upstream module | Replaced by | Why |
|---|---|---|
| `src/plugins/i18n.js` | `server/src/shims/i18n.js` | Eagerly imports every locale bundle. The shim is a single English-only `createI18n` instance (loaded from `en.json`) that `server/src/app.js` also installs on the headless app, so `useI18n()` and direct `i18n.global.t` callers (`request.js` error text) both translate; it used to echo raw keys, which leaked into API error toasts and logs |
| `src/plugins/index.js` | `server/src/shims/plugins-index.js` | Re-exports `./components` (raw `.vue`, unparseable under Node) and `./router` |
| `src/plugins/router.js` | `server/src/shims/router.js` | Imports every view directly to build its route table |
| `src/stores/ui.js` | `server/src/shims/ui.js` | Dialog bookkeeping only — a headless process has no dialogs |
| `src/stores/modal.js` | `server/src/shims/modal.js` | `confirm`/`alert`/`prompt` resolve as if declined; `otpPrompt` is the one real implementation, reading a 2FA code from stdin |
| `src/workers/activityWorkerRunner.js` | `server/src/shims/activity-worker-runner.js` | Vite-only `?worker&inline` import; every message type is a pure function from `activityEngine.js`, run in-process instead |
| `src/stores/quickSearchWorker.js` | `server/src/shims/quick-search-worker.js` | Same Vite-only problem, but stateful with zero imports — loads the real file's source via a `data:` URL |
| `src/localization/index.js` | `server/src/shims/localization.js` | `import.meta.glob(...)`; `languageCodes` re-exported for real from the Vite-free `./locales.js` |
| `src/shared/utils/appActions.js` | `server/src/shims/app-actions.js` | UI actions (confirm dialog, clipboard, `<a download>`); the other ~31 files in that barrel are real, unaliased business logic |
| `src/shared/utils/base/ui.js` | `server/src/shims/base-ui.js` | Theme/font/CSS DOM mutation; `HueToHex`/`HSVtoRGB`/`getThemeMode` reimplemented for real |
| `worker-timers` *(package)* | `server/src/shims/worker-timers.js` | Schedules through a blob-URL Worker, which doesn't exist in Node; plain timers are correct here |
| `vue-sonner` *(package)* | `server/src/shims/toast.js` | Toast calls throughout `request.js`/`websocket.js`/13 coordinators → structured log lines |
| `noty` *(package)* | `server/src/shims/noty.js` | Login/logout greeting; runs `document.addEventListener` at module load, so it must be a package alias, not a deferred-call shim |
| `src/shared/utils/clock.js` *(new file, fork-added)* | `server/src/shims/clock.js` | `src/stores/activity.js`'s "now" for a still-open self activity session. Live clients correctly bound it just by existing (the computation only runs while they're open); bounded to desktop-agent connectivity server-side instead — see the shim's own doc comment and this row's sibling entry in the patch inventory (§5) for the "100% overlap with a 24/7 server" bug this fixes |

All aliases are permanent (Vite-only syntax, or a genuinely headless-incompatible concern), except `modal.js`'s `otpPrompt`, which is a real implementation, not a stub.

### The store-graph problem (measured, not estimated)

Importing *any* background store pulls a **629-file closure including ~300 `src/components/**` and ~144 `src/views/**`**, through exactly two edges: `src/stores/settings/appearance.js:29` → `src/plugins/index.js`, and `src/stores/avatarProvider.js:4` → `src/plugins/router.js`. Aliasing those two (above) drops it to **148 files and 11 npm packages** — the entire reason the server can run the real store graph at all.

One benign-looking edge to leave alone: `src/stores/gameLog/index.js:5` imports `src/views/GameLog/sessions/buildGameLogSessions.js`, a pure function that merely lives under `views/`. Don't add a path-prefix rule that rejects it — `.dockerignore` keeps `src/**` whole for this reason.

---

## 5. Patch inventory

**Full table: [`docs/patch-inventory.md`](docs/patch-inventory.md)** — read it before editing any upstream-owned file, and when resolving an upstream-merge conflict (find the file's row, then re-apply the change from its anchor).

Invariant 6 still applies: every unavoidable edit to `src/**`, `Dotnet/**`, `src-electron/**` or other upstream-owned files gets a row there, with enough anchor context to re-find it after upstream reformats the file. Prefer aliasing (invariants 2–3); the table has no size cap.

---

## 6. Upstream sync procedure

Upstream's default branch is **`master`**; ours is **`main`**. The `upstream` remote is `https://github.com/vrcx-team/VRCX.git`.

If a checkout is missing it, add it with `git remote add upstream https://github.com/vrcx-team/VRCX.git`, **then immediately run `gh repo set-default WentTheFox/VRCX-Headless`**. Once an `upstream` remote exists, `gh` resolves the default repo to `vrcx-team/VRCX`, so a bare `gh pr create` targets upstream. Found live (2026-09-26): it failed only by luck, because the sync branch didn't exist there.

Sync to either a tagged release or `master` HEAD, deliberately — a tag gives a discrete, reviewable step; `master` gets whatever's landed since the last sync, which is a moving target under an active, UI-heavy project, but is sometimes exactly what's wanted (e.g. testing how well this doc's own procedure holds up against real upstream drift).

```bash
git fetch upstream --tags master

# syncing to a tagged release
git checkout -b sync/<tag> main
git merge v2026.07.18   # the tag being synced to, not upstream/master

# syncing to master HEAD instead
git checkout -b sync/master-<date> main
git merge upstream/master
```

Pick a tag deliberately — `git tag -l 'v*' | sort -V | tail -5` (or the [releases page](https://github.com/vrcx-team/VRCX/releases)) — rather than always grabbing the newest, when that's the path taken.

### 6.1 Expected conflicts, ranked

1. `package.json` — dependency bumps land next to our identity/scripts changes. Keep both sides; take upstream's dependency block wholesale.
2. `.github/workflows/ci.yaml` — take upstream's job definitions, keep our `on:` block.
3. `src/plugins/interopApi.js`, `src/vite.config.js` — see §5.

Files under `src/services/database/**` and `src/services/config.js` should merge **cleanly** — we do not modify them. A conflict there means someone broke invariant 1.

### 6.2 Change-detection checklist

These break the split *without* producing a merge conflict. Check every one.

- [ ] **Schema version bumped?** `grep -n 'const databaseVersion' src/stores/vrcx.js`. The server reads this automatically, but new migrations must be re-run against the live DB.
- [ ] **New or renamed `database.*` methods?** `git diff main..upstream/master -- src/services/database/`. New methods work automatically (name-based Proxy); **renames break call sites**, and new DDL needs a migration run.
- [ ] **`initUserTables` prefixing changed?** Asserted in `server/test/db.test.js`.
- [ ] **`configRepository` signatures changed?** Any change breaks the client's cached shim (invariant 4).
- [ ] **`window.SQLite` contract changed?** `git diff main..upstream/master -- Dotnet/SQLite.cs src/services/sqlite.js`. Mirror new methods/row shapes in `server/src/shims/sqlite.js`.
- [ ] **Vite `define` block changed?** New compile-time globals need `server/src/globals.js` *and* `server/vitest.config.js`.
- [ ] **New browser-only imports in the data layer?** `grep -rn "^import" src/services/database/ src/services/config.js src/services/sqlite.js` — anything beyond `../sqlite.js`, `../database`, and the aliased modules needs a decision.
- [ ] **New `window.AppApi` methods used from stores/views?** Need a `client-web/shims/app-api.js` entry or the web client throws at runtime.
- [ ] **New `worker-timers`/`speechSynthesis`/`window.crypto` usage** in modules the server imports.
- [ ] **New `LINUX`/`isLinux` checks?** `git diff main..upstream/master -G'\bLINUX\b' -- src/`. For each, decide whether it means "Electron shell" (fine as is) or "host OS" (needs `hostOs.js` — see §1's "Build flags are not OS flags").
- [ ] **`handlePipeline` gained event types?** New cases must be forwarded on the client stream.
- [ ] **`Dotnet/WebApi.cs` changed?** `git diff main..upstream/master -- Dotnet/WebApi.cs src/services/webapi.js`. The cookie blob format, the `data:image/png;base64,` prefix, header rules, and the `-1` sentinel are all mirrored in `server/src/shims/webapi.js` and `server/src/cookies.js`.
- [ ] **Did an aliased module gain exports, or did upstream add non-erasable TypeScript?** The mocked unit tests can't see either; only a real boot can. After any sync, run `pnpm run server -- serve` against a scratch DB (`VRCX_DATABASE=<tmp> ... migrate --create` first) and wait for `Serving on` (it takes up to ~2 minutes, and the default port 9000 can be reserved on Windows: set `VRCX_SERVER_PORT`). Found live (2026-10-15): `appearance.js` started importing `setSystemIsDarkMode` from `base/ui.js`, which `server/src/shims/base-ui.js` didn't export, so the server died at import time while all 174 server tests passed. A new `enum`/`namespace`/parameter-property in a `.ts` file would fail the same way, since Node strips only erasable syntax.
- [ ] **New `src/plugins/index.js`/`router.js` importers** in stores/coordinators? Those two aliases are what keep the component/view tree out of the server closure.
- [ ] **New npm dependency in the server's closure?** Add to `server/package.json` *and* root, or the container fails at runtime while dev works. `node server/scripts/check-deps.js` catches version mismatches.
- [ ] **New browser global used at module or store-setup scope?** Fails at import time in Node, not call time. See §3.7.
- [ ] **A `database.*` method now returns a `Map`/`Set`?** `JSON.stringify` silently drops them (`{}`); `server/src/http-server.js`'s `sendJson` replacer already converts both to arrays generically, but confirm the new method is actually routed through `sendJson`.
- [ ] **Reset `server/VERSION` to `1.0` — but only if `Version` (the repo-root file) actually changed.** The reset exists because the synced-to tag changes the *major* component of the next server/Docker release version (§10's "Server/Docker versioning"), restarting the fork's own MINOR.PATCH counter against the new base. Syncing to `master` HEAD (§6, "syncing to master HEAD instead") without a new dated upstream tag leaves `Version` unchanged — found live (2026-08-25): resetting to `1.0` in that case would tag a `v<same-major>.1.0` that's *already been used* by a much earlier release under the same base, since the major component didn't actually move. When `Version` didn't change, keep bumping the existing MINOR/PATCH counter instead, per the ordinary "Cutting a release" rule below.

### 6.3 Verify before pushing the merge

```bash
pnpm install --frozen-lockfile
pnpm run test:server      # the split's own guarantees
pnpm test                 # upstream's suite must not regress
pnpm run lint && pnpm run format:check
node --import ./server/register-hooks.mjs server/src/cli.js info
```

Then, against a **copy** of a real database:

```bash
cp ~/.config/VRCX/VRCX.sqlite3 /tmp/parity.sqlite3
pnpm run server -- migrate --db=/tmp/parity.sqlite3
pnpm run server -- tables --db=/tmp/parity.sqlite3
```

Diff `sqlite_schema` against the same database migrated by the desktop build. They must be identical.

---

## 7. Server usage (current state)

Full setup and Docker instructions: **`server/README.md`**. Quick reference:

```bash
pnpm run server -- info                      # where the DB is, version, who is logged in
pnpm run server -- migrate [--user=usr_...]  # run the JS migration layer
pnpm run server -- tables                    # row counts per table
pnpm run server -- query "SELECT ..."        # read-only, positional rows
pnpm run server -- reset-activity-cache      # clear cached Activity/Overlap tables (rebuild from source data)
pnpm run server -- login                     # VRChat login, prompts for 2FA
pnpm run server -- whoami                    # check the stored session
pnpm run server -- pipeline                  # stream VRChat events
pnpm run server -- serve                     # HTTP/WS server for clients + agent
pnpm run server -- setup-totp                # (re)issue the serve auth secret
pnpm run server -- check-update              # is upstream ahead of this fork's last sync?
pnpm run test:server
```

`login` → `whoami` → `pipeline` → `serve` are all verified end-to-end against a real VRChat account, outside CI (`api.vrchat.cloud` isn't reachable from there).

Environment: `VRCX_DATABASE`, `VRCX_DATA_DIR`, `VRCX_LOG_LEVEL` (`debug|info|warn|error`), `VRCHAT_PASSWORD`/`VRCHAT_2FA_CODE` for non-interactive login, `VRCX_SERVER_TOTP_SECRET` to set `serve`'s auth secret non-interactively.

`--user` is only needed to create per-user tables for an account the database has never seen; `login` does it automatically, and migrations for existing accounts discover their tables through `sqlite_schema` queries.

**Credentials are stored the way upstream stores them.** With no primary password set, `savedCredentials` holds the password in plaintext — that is upstream VRCX behaviour (`src/stores/auth.js:919-930`), not something this fork introduced. Do not silently "fix" it here; it would desync the desktop app. Treat `VRCX.sqlite3` as a secret.

---

## 8. Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Fork hygiene: upstream remote, unshallow, identity, CI on PRs | done |
| 1 | Server skeleton: SQLite shim, alias/loader layer, migrations, CLI, tests | done |
| 2a | Server owns the VRChat connection: WebApi shim, cookie jar, login/2FA CLI, pipeline connection, multi-arch container | done |
| 2b | Pinia-in-Node: the background stores and the `updateLoop` daemon | done |
| 3 | Transport: TOTP auth → session/bearer token, generic `/api/rpc` dispatcher, `/api/stream` WebSocket fan-out | done |
| 4 | Web client: `PLATFORM=web`, `client-web/shims/**`, `capabilities` gating | done |
| 5 | Desktop client as native agent: log forwarding up, overlay/Discord/notification commands down; .NET stops touching SQLite | done |
| 6 | Hardening: single-writer lock, awaited client writes, packaging | done |

All six phases plus TOTP auth, the desktop multi-server switcher, the Groups-sidebar relay, and the cross-platform desktop release pipeline (§10) are implemented and in use. The detailed build history (bugs found, live-verification notes, the 2026-08-17 upstream sync, the npm→pnpm migration) lives in git log/commit messages, not here — this file tracks current state and how to keep it that way, not how it got here. §9 lists what's a deliberate scope cut rather than unfinished work.

---

## 9. Known limitations

**Full list: [`docs/known-limitations.md`](docs/known-limitations.md)** — deliberate scope cuts (single account, two settings stores, web-client `AppApi` coverage, one desktop agent, no server lifecycle management, …) and the complete fork-updater design write-up (pre-window main-process check, `.no-updater`, MINOR/PATCH matching, hash verification). Read it before touching `checkAndInstallForkUpdate`, `vrcxUpdater.js` or `server/src/update-release.js`.

---

## 10. The container

**Full guide: [`docs/release.md`](docs/release.md)** — Dockerfile design, `<vrcx-date>.<minor>.<patch>` versioning (MINOR = needs server redeploy, PATCH = client-only), the "Cutting a release" steps, and desktop release artifacts/signing. Read it before tagging a release or touching `server/VERSION`, `server-docker.yaml` or `desktop-release.yaml`.

Quick rule: after an upstream sync, reset `server/VERSION` to `1.0` only if the repo-root `Version` file changed (§6.2).
