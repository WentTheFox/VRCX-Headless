# VRCX-Headless — fork architecture and upstream migration guide

This fork splits [VRCX](https://github.com/vrcx-team/VRCX) into two pieces:

- a **headless server** that owns the VRChat API connection and is the *sole writer* of `VRCX.sqlite3`
- a **client** — the existing Vue app — that runs either in a browser or inside the Electron desktop shell, and stays in sync across devices off a server event stream

Upstream is a fast-moving, UI-heavy project, and `.github/CONTRIBUTING.md` says UI PRs are declined there, so **everything we diverge on is permanently ours to maintain**. This document exists to make each upstream merge mechanical rather than archaeological.

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

A Node ESM `resolve` hook (registered by `server/register-hooks.mjs`) emulates Vite's resolver — `src/**` uses extensionless and directory imports plain Node rejects, so the hook tries the exact path, then `.js`/`.mjs`/`.json`, then `index.js` — and applies two alias maps from `server/aliases.js`: `aliases` (keyed by *resolved absolute path*, robust to however a module spells its import) and `packageAliases` (keyed by bare npm specifier, for packages that can't run under Node at all, matched before path resolution). It also forces `format: 'module'` for `src/**`, since the root `package.json` has no `"type": "module"`.

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
| `src/plugins/i18n.js` | `server/src/shims/i18n.js` | Eagerly imports every locale bundle; the data layer only calls `i18n.global.t` |
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

All aliases are permanent (Vite-only syntax, or a genuinely headless-incompatible concern), except `modal.js`'s `otpPrompt`, which is a real implementation, not a stub.

### The store-graph problem (measured, not estimated)

Importing *any* background store pulls a **629-file closure including ~300 `src/components/**` and ~144 `src/views/**`**, through exactly two edges: `src/stores/settings/appearance.js:29` → `src/plugins/index.js`, and `src/stores/avatarProvider.js:4` → `src/plugins/router.js`. Aliasing those two (above) drops it to **148 files and 11 npm packages** — the entire reason the server can run the real store graph at all.

One benign-looking edge to leave alone: `src/stores/gameLog/index.js:5` imports `src/views/GameLog/sessions/buildGameLogSessions.js`, a pure function that merely lives under `views/`. Don't add a path-prefix rule that rejects it — `.dockerignore` keeps `src/**` whole for this reason.

---

## 5. Patch inventory

Every modification to an upstream-owned file, logged per invariant 6. Prefer aliasing when a clean seam exists (invariant 2-3), but patch as much as is actually necessary — this table has no size cap.

<details>
<summary>Full table (20 entries)</summary>

| File | Change | Why not an alias | Anchor |
|---|---|---|---|
| `package.json` | `name`/`description`/`homepage`/`bugs`/`repository` retargeted at the fork; `test:server`/`server` scripts; `tough-cookie`, `ws`, `qrcode-generator`, `@vue/runtime-core` dependencies (the last a phantom dependency `server/src/app.js` always needed directly — only ever worked under npm by accident of flat hoisting, caught live by pnpm's strict `node_modules` linking during the 2026-08-17 pnpm migration); `dev-web`/`prod-web` scripts (`prod-web` wraps *both* halves of its `vite build && pnpm run build:licenses` chain in `cross-env PLATFORM=web` — `cross-env`'s env var only applies to the single command it directly wraps, so without the second one, `build:licenses` silently ran as if for `PLATFORM=windows`); `packageManager`/`engines.pnpm` (pnpm migration); `oxlint`/`eslint-plugin-oxlint` pinned to an exact version rather than `^` (same migration — a fresh pnpm resolution drifting to a newer, still-range-satisfying patch was never going to break CI, since `oxlint`'s own CI step already runs with `continue-on-error: true`, but pinning avoids the drift being a surprise at all) | Package identity, scripts, and dependency declarations can't be aliased. `tough-cookie`/`ws`/`@vue/runtime-core` are also real deps in `server/package.json` — `server/scripts/check-deps.js` enforces the two match. `electron-builder`'s own file allowlist (`build.files`, formerly inline here) now lives in `electron-builder.config.js`, upstream's own new file as of the same sync — see that file's own entry below | top-of-file metadata; `scripts`; `dependencies`/`devDependencies`; `packageManager`/`engines` |
| `electron-builder.config.js` | New file as of the 2026-08-17 upstream sync (upstream moved `build.files`/etc. out of `package.json` into this file — see that row above); `files` gained `client-desktop/setup.html`, `client-desktop/setup.js`, `node_modules/qrcode-generator/dist/qrcode.js`, the same three fork-only entries `package.json`'s old inline `build.files` used to carry. Later (2026-08-18): `productName` → `'VRCX Headless'`, both `linux`/`mac` `artifactName` templates' literal `VRCX_Version.${ext}` placeholder → `VRCX-Headless_Version.${ext}`, and the Linux `desktop.entry.Name`/`description`/`maintainer`-adjacent `description` field reworded to identify this as the fork client | `electron-builder` only reads its config from one place — a fork-owned file alongside it isn't an option, since `electron-builder` doesn't merge multiple config sources. The branding change was needed after the first real release shipped downloads literally named `VRCX_2026.07.18_x64.AppImage` — indistinguishable from a vanilla VRCX download and carrying the plain VRCX date instead of this fork's own version | `files` array; `productName`; `linux.artifactName`/`mac.artifactName`; `linux.desktop.entry.Name`/`description` |
| `build-scripts/utils.js` | (2026-08-18) Added `getForkVersion()`, re-deriving `server/src/globals.js`'s `buildServerVersion()` scheme (`<vrcx-date-no-dots>.<fork-build>.0`) independently, since these are plain CommonJS scripts outside the server's ESM/hooks module graph | Small enough (two file reads + a string join) that importing across the module-system boundary wasn't worth it | new `getForkVersion` export |
| `build-scripts/patch-package-version.js` | (2026-08-18) Now calls `getForkVersion()` instead of reading the plain VRCX `Version` file directly, so `package.json`'s `version` field — and therefore electron-builder's implicit Windows NSIS filename, which has no explicit `win` artifactName override — carries this fork's own version | Same branding motivation as `electron-builder.config.js` above; this is the one platform where the version string comes from `package.json` rather than an explicit rename step | the whole version-computation block |
| `build-scripts/rename-builds.js` | (2026-08-18) Same `getForkVersion()` switch, plus the renamed-to filenames now use a `VRCX-Headless_` prefix instead of `VRCX_`, matching `electron-builder.config.js`'s updated `artifactName` placeholder (both sides of the rename must agree on the literal intermediate filename electron-builder actually produces) | Same branding motivation | `renameBuild()`'s old/new filename construction |
| `package.json` | (continuing the entry above, 2026-08-18) `desktopName` → `'VRCX-Headless'` (the `.desktop` filename electron-builder writes for Linux, via `syncDesktopName: true`) | Same branding motivation; kept alongside the file's existing entry rather than a new row since it's the same field-level pattern as the scripts changes above | `desktopName` |
| `build-scripts/generate-third-party-licenses.js` | Reads `PLATFORM` the same way `src/vite.config.js` does; `frontendLicensePath`/`outputDir` follow vite's own per-platform `outDir` (`build/html-web` vs `build/html`) instead of hardcoding the latter; the `Dotnet/**`/NuGet scan is skipped entirely (not just guarded) when `PLATFORM=web`, since a browser build ships none of that code | The script has no smaller seam to alias through — it's a standalone CLI tool, not something imported into a module graph aliasing can intercept | top-of-file `isWeb`/`htmlDir`/`frontendLicensePath`/`outputDir` constants; `main()`'s `dotnetEntries` computation |
| `.github/workflows/ci.yaml` | Re-enabled the `pull_request` trigger (upstream ships it commented out) and added `push` on `main` | CI config can't be aliased | `on:` block at the top |
| `.gitignore` | Added `!CLAUDE.md` — upstream ignores AI guidance files, but this one is the fork's maintenance guide. Later (2026-08-18): added a `*.pfx`/`*.p12` block so the self-signed release-signing certs `build-scripts/generate-self-signed-certs.sh` produces can never be accidentally committed | Ignore rules can't be aliased | after the `AGENTS.md`/`AI_GUIDE.md`/`CLAUDE.md` lines; the `*.pfx`/`*.p12` block near the end |
| `README.md` | Added a short "About this fork" block pointing at `server/README.md` and this file | Docs can't be aliased; kept to a pointer since the real docs live in `server/README.md` | immediately before `# Getting Started` |
| `src/plugins/interopApi.js` | A third `else if (WEB)` branch beside `WINDOWS`/Electron, installing `client-web/shims/{webapi-target,app-api,vrcx-storage,log-watcher}.js`. The Electron branch swaps `window.WebApi` for `client-desktop/shims/webapi-target.js`, calls `client-desktop/shims/pipeline-relay.js`'s `installPipelineRelay()` (see the seam table's Pipeline WS row), and stops installing `window.SQLite`; `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager`/`AppApiVrElectron` stay the real `InteropApi.*` objects. Both `WEB` and Electron branches call `installUnhandledRejectionReporting()` (defined in this file) — reports failed RPC writes via the existing `vue-sonner` toast convention, skipping `WINDOWS`/CefSharp (no RPC hop there) and skipping any error already flagged `alreadyToasted` by `app-api.js`'s own toast-then-throw. Later (2026-08-24): the Electron branch also installs `window.updateService` (`client-desktop/shims/update-service.js`) — backs the fork-updater's server-driven update check, §9's own write-up | This *is* the seam table's designated native-globals injection point | `if (WINDOWS) {...} else {...}` inside `initInteropApi`; `installUnhandledRejectionReporting` above it; the `window.updateService` line in the Electron branch |
| `src/vite.config.js` | `WEB` added to the `define` block; a platform-conditional `resolve.alias` (`server/vite-alias-plugin.js`, reused for `PLATFORM === 'linux'` too via `client-desktop/aliases.js`); separate `outDir` per platform; dev-mode port/proxy branch; `publicDir` pinned explicitly to `src/public` (Vite otherwise defaults it relative to `root`, and neither client root has its own `public/`, silently dropping every asset under `src/public/**`) | Build config can't be aliased — this file *is* the alias mechanism for everything else | `define`; `plugins`; `server`/`build.outDir`/`build.rolldownOptions.input`; `publicDir` |
| `src-electron/main.js` | `SQLite`/`WebApi` .NET object `Init()` calls removed entirely. IPC handlers: `vrcx-connect-server` (logs into a remote server, opens `/api/agent`, answers forwarded calls via the real `interopApi.callMethod`), `vrcx-rpc` (relays `database`/`config`/`webapi`), `vrcx-totp-setup`/`vrcx-totp-confirm`, and the multi-server set `vrcx-list-servers`/`vrcx-switch-server`/`vrcx-remove-server`/`vrcx-set-default-server`/`vrcx-get-server-status` (`VRCX_Servers` storage, reachability tracking, `restartApp()` extracted so both `app:restart` and the switch handler share it — `vrcx-get-stored-server-url` was removed once `vrcx-list-servers` made it a strict subset). A startup gate probes the stored session before loading the real app vs. `client-desktop/setup.html`. Also fixes a genuine pre-existing upstream bug (predates this fork, `74bae434`): `--x11` only skipped the auto-relaunch decision without telling Chromium to actually use X11, so on Wayland+Vulkan the window never became visible — now appends `ozone-platform=x11` to `app.commandLine`. Found live (2026-08-17): connecting to a self-signed-but-OS-trusted headless server (e.g. a homelab `step-ca` cert already in the Windows trust store) failed every RPC call with a bare `fetch failed` — this process's `fetch`/`ws` calls run through plain Node's TLS stack, which trusts only its own bundled Mozilla CA bundle, never the OS certificate store, regardless of what the OS or a browser trusts. `vrcx-import-ca-cert`/`vrcx-remove-ca-cert`/`vrcx-get-ca-cert-status` let a user import a CA cert from the connection UI, written to `<userData>/custom-ca.pem`; a self-relaunch gate at the top of the file sets `NODE_EXTRA_CA_CERTS` to that path and restarts once whenever the file exists but the running process wasn't started with it, since Node only reads that env var at process bootstrap, never at runtime. Also found live the same day: `vrcx-stream-connect`/`vrcx-stream-close` open the real `/api/stream` connection here (with the `Authorization: Bearer` header the renderer can't attach itself) and forward every frame to `client-desktop/shims/pipeline-relay.js`'s relayed `WebSocket` object — see the seam table's Pipeline WS row for why this replaced a direct renderer→VRChat connection. Found live (2026-08-23): every `fetchJson` failure surfaced as a bare, unactionable `"fetch failed"` (Node's `fetch` collapses refused connections, DNS failures, timeouts, and TLS errors into that one message, with the real reason nested in `err.cause`) — `describeFetchError()` unwraps it once at the `fetchJson` choke point into text a user can actually act on (e.g. "is a VRCX server actually running at that address and port?"), reaching every caller for free. Also found live the same day, on real hardware rather than a sandbox (two earlier "fixes" both silently tested a stale cached AppImage extraction and never actually ran): `restartApp()`/`before-quit`/the ozone self-relaunch could leave the old process and tray icon stuck forever with no new window ever appearing, because `app.exit()`'s native shutdown path can itself hang on this Linux session (DBus/tray teardown) — `scheduleForceExitFallback()` spawns a detached `sh -c 'sleep 3; kill -9 <pid>'` watchdog, scheduled as the *first* action in each of those three call sites (a `setTimeout`-based fallback tried first is provably useless: it can never run on a thread that's blocked in the exact native call it's meant to route around), immune to that same hang since `SIGKILL` is delivered by the kernel regardless of what the target thread is doing. Also renamed every user-facing string in this file (`mainWindow`'s `title`, pinned against the upstream page overwriting it via `page-title-updated`; the tray tooltip/quit-menu label; every `dialog.showErrorBox`/`showMessageBoxSync`) from plain `VRCX` to `VRCX Headless Desktop` — `client-web/**`'s and `client-desktop/setup.{html,js}`'s own title tags/headings got the matching `VRCX Headless Web`/`VRCX Headless Desktop` treatment, fork-owned files needing no separate log entry here — so a running instance of this fork is never mistaken for the real desktop app at a glance. Also found live the same day: `installVRCX()`/`updateDesktopFile()` hardcoded plain `VRCX.AppImage`/`VRCX.desktop` throughout (upstream's own convention, otherwise unmodified) — the exact filenames the real desktop app installs to, so a machine with both installed would have each one silently overwrite the other's copy in `~/Applications` and launcher entry in `~/.local/share/applications` depending on launch order, and `updateDesktopFile()`'s own "no existing file" branch also read the wrong bundled filename to begin with (`electron-builder.config.js`'s `desktopName` actually bundles `VRCX-Headless.desktop`, never `VRCX.desktop`, so that branch always failed silently on a genuinely fresh install). Both the installed AppImage and desktop-entry filenames are now `VRCX-Headless.{AppImage,desktop}` throughout, matching what's actually bundled and never colliding with the real app's own files; `electron-builder.config.js`'s `linux.desktop.entry.Name` updated to `VRCX Headless Desktop` to match. Found live (2026-08-23, Windows): `getVersion()` (feeding `AppApi.GetVersion()`, and so the Settings page's "Version" line) hardcoded a hardcoded `VRCX (Linux)` prefix regardless of actual host OS — a leftover from upstream only ever building this Electron client for Linux (§1's "Desktop client OS support" table) — misleading once this fork's Electron build genuinely runs on Windows too; now `VRCX Headless`. Also switched the number after that prefix from the raw upstream `Version` file (`2026.07.18`) to `app.getVersion()` — this fork's own release version, i.e. `package.json`'s `version` field as patched at build time by `build-scripts/patch-package-version.js` (same `<vrcx-date-no-dots>.<fork-build>.0` scheme as the Docker tag, CLAUDE.md's "Server/Docker versioning") — so the Settings page shows which *fork release* is installed, not just which upstream date it's based on; the raw upstream string is still shown separately (`src/stores/vrcxUpdater.js`'s new `upstreamVersion`, "Based on VRCX version" in Settings). Found live (2026-08-24, Windows, via the new fork-updater's restart-after-install path — §9): `scheduleForceExitFallback()` was only ever externally gated to `process.platform === 'linux'` at *two* of its three call sites (`restartApp()`'s Linux branch, `tryRelaunchWithArgs`'s own early return) — the third, the global `app.on('before-quit', ...)` handler, calls it unconditionally on every platform. Since that handler fires on *any* `app.quit()`, including `restartApp()`'s own Windows branch, a plain Windows restart threw an uncaught main-process exception ("spawn sh ENOENT" — the watchdog's whole mechanism is a Linux-only DBus/tray-teardown workaround that shells out to `sh`, which doesn't exist on Windows) right after a successful update download. Moved the guard inside `scheduleForceExitFallback()` itself instead of patching the third call site alone, so every caller — present or future — is safe by construction rather than by remembering to check the platform first | `main.js`'s own boot sequence and IPC surface — nothing to alias, the point is changing what it does at startup; the ozone fix, the CA-cert gate, and the stream relay all have no smaller seam to alias through | `interopApi.getDotNetObject(...)` block near the top; `const x11 = args.includes('--x11')`; the `ipcMain.handle(...)` calls; `createWindow()`'s `mainWindow.loadFile(...)`; the `customCaCertPath`/self-relaunch block right after the `//app.disableHardwareAcceleration();` line; the three `vrcx-*-ca-cert` handlers beside `dialog:openDirectory`; `streamSocket` beside `agentSocket`, and the `vrcx-stream-connect`/`vrcx-stream-close` handlers right after `connectAgentSocket`; `describeFetchError`/`scheduleForceExitFallback` right above `fetchJson`/`restartApp`; the `title`/`page-title-updated` lines in `createWindow()`; `getVersion()` near the bottom of the file |
| `src-electron/preload.js` | A `vrcxDesktopAgent` `contextBridge.exposeInMainWorld` (`connectToServer`, `rpc`, `checkTotpSetupNeeded`, `confirmTotpSetup`, the multi-server `listServers`/`switchServer`/`removeServer`/`setDefaultServer`/`getServerStatus`/`onServerStatusChanged`, `importCaCert`/`removeCaCert`/`getCaCertStatus`, and `streamConnect`/`streamClose`/`onStreamEvent`) beside the existing `interopApi` one | Same reasoning as the `interopApi` bridge — a new IPC surface needs a new bridge entry | beside the existing `contextBridge.exposeInMainWorld('interopApi', ...)` call |
| `Dotnet/AppApi/Electron/GameHandler.cs` | `StartGame`/`StartGameFromPath` branch on `RuntimeInformation.IsOSPlatform(OSPlatform.Windows)`; the Windows branch (`StartGameWindows`/`StartGameFromPathWindows`) is a straight port of `Dotnet/AppApi/Cef/GameHandler.cs`'s own Steam/VRChat registry lookup; the pre-existing logic (unindented, just renamed) becomes `StartGameLinux`. `IsGameRunning`/`QuitGame` gained a `GetVrChatProcessName()` helper picking `"VRChat"` on Windows vs `"VRChat.exe"` elsewhere | Found live (2026-08-17, Windows): the Electron client's native layer was written Linux-only end to end (see CLAUDE.md's own "Desktop client OS support" note in §1) — `StartGame` shelled out to a `steam`/`steam.sh` binary that doesn't exist on Windows, so VRChat autodetection always failed there with no Windows path at all, not a regression from anything else in this fork. A second bug in the same vein, found right after fixing the client-desktop daemon gap (below): `Process.GetProcessesByName("VRChat.exe")` can never match on native Windows — `Process.ProcessName` never includes the `.exe` suffix there, unlike a Wine-run process on Linux, which keeps it in the OS process table — so the "game" status indicator and GameLog tailing stayed dead on Windows even with VRChat.exe confirmed running in Task Manager, until this was OS-branched too. Scoped narrowly to game-launch/detection — the rest of `Folders.cs` (screenshot/app-data/crash paths, `xdg-open`/`nautilus`-based folder opening) and `TryOpenInstanceInVrc` (`nsenter`+`wine`) are still Linux-only and untested on Windows | `StartGame`/`StartGameFromPath`'s OS branch; the `StartGameWindows`/`StartGameFromPathWindows`/`StartGameLinux` methods; `GetVrChatProcessName()` above `IsGameRunning` |
| `Dotnet/VRCX-Electron.csproj` | Added `<PackageReference Include="Microsoft.Win32.Registry" Version="5.0.0" />`. Later (2026-08-18): `<RuntimeIdentifiers>` extended from `linux-x64;linux-arm64` to also include `win-x64;osx-x64`, additive only — the active `<RuntimeIdentifier>` default and `<DefineConstants>LINUX</DefineConstants>` are untouched | The project's plain `net10.0` TFM (no `-windows` suffix, unlike `VRCX-Cef.csproj`'s `net10.0-windows10.0.19041.0`) doesn't include `Microsoft.Win32.Registry` types by default — needed for the `GameHandler.cs` Windows branch above. The RID addition is what lets `.github/workflows/desktop-release.yaml` (§10's "Desktop client release artifacts") build a genuine win-x64/osx-x64 self-contained target via an explicit `-r <rid>` flag, rather than relying on `dotnet build`'s implicit host-inferred behavior | `ItemGroup` with the other `PackageReference`s; `<RuntimeIdentifiers>` |
| `Dotnet/VRCX-Electron-arm64.csproj` | (2026-08-18) `<RuntimeIdentifiers>` extended from `linux-x64;linux-arm64` to also include `win-arm64;osx-arm64`, additive only, same reasoning as the x64 csproj above | Same as above — needed for `desktop-release.yaml`'s win-arm64/osx-arm64 legs | `<RuntimeIdentifiers>` |
| `src/styles/globals.css` | One `@source '..';` line right after `@import 'tailwindcss';` | Tailwind v4's content detection scans relative to Vite's root; `client-web/`'s root is a *sibling* of `src/`, not an ancestor, so classes used only deep in `src/**` (e.g. `sr-only`) never made it into the web build. `@source` only works inside the same `@import` chain as `tailwindcss` itself — a plain JS `import` of a separate CSS file doesn't register. No-op for the desktop build | immediately after `@import 'tailwindcss';` |
| `src/stores/vrcxUpdater.js` | One `if (typeof HEADLESS !== 'undefined' && HEADLESS) { noUpdater.value = true; }`, mirroring the existing `if (isMacOS.value) { noUpdater.value = true; }` line right above it. Later (2026-08-23): new `upstreamVersion` ref, set to the bare `VERSION` compile-time global (upstream's own raw `Version` file content, installed the same way for the server too — `server/src/globals.js`'s `globalThis.VERSION = readVersion()`) right after `appVersion.value = await AppApi.GetVersion()` — surfaces the plain upstream date alongside this fork's own branded `appVersion`, exposed in Settings as "Based on VRCX version" (`SystemTab.vue`, see that file's own entry). `currentVersion`'s strip target changed from `' (Linux)'` to `' Headless'`, matching `src-electron/main.js`'s `getVersion()` rename — still restores a plain `VRCX Nightly <version>`/`VRCX <version>` string for the Nightly-branch-detection and version-comparison logic below it | Found live: this store self-invokes its own init on construction (no external call site to gate), unconditionally hitting VRCX's update-check API on every server boot — a headless process has no install flow to act on regardless of whether that API is reachable. `HEADLESS` (`server/src/globals.js`) is a new real global, `true` only on the server and genuinely undefined everywhere else (including the web client, which keeps real update-checking) — referenced defensively via `typeof`, not a bare identifier, since it's not in Vite's `define` block. `upstreamVersion`/`currentVersion` can't be aliased — they're a couple of lines inside a store that's otherwise real, unaliased upstream logic. **(2026-08-24)** New, entirely additive block right after `currentVersion`: `forkUpdateStatus`/`forkServerVersion`/`forkUpdateError`/`installedForkVersion` refs, `getForkAssetOfInterest`/`checkForForkUpdate`/`installForkUpdate` functions — the server-driven desktop updater, §9's own write-up has the full design. Doesn't touch `checkForVRCXUpdate`/`getAssetOfInterest`/`downloadVRCXUpdate`/`branches` at all, reuses only `arch`/`updateInProgress`/`updateProgress`/`downloadFileProgress`/`restartVRCX`, all pre-existing | Found live: this store self-invokes its own init on construction (no external call site to gate), unconditionally hitting VRCX's update-check API on every server boot — a headless process has no install flow to act on regardless of whether that API is reachable. `HEADLESS` (`server/src/globals.js`) is a new real global, `true` only on the server and genuinely undefined everywhere else (including the web client, which keeps real update-checking) — referenced defensively via `typeof`, not a bare identifier, since it's not in Vite's `define` block. `upstreamVersion`/`currentVersion` can't be aliased — they're a couple of lines inside a store that's otherwise real, unaliased upstream logic. The fork-updater block is new functionality with no upstream equivalent to alias against, so it's additive by construction rather than a choice | inside `initVRCXUpdaterSettings()`, right after the `isMacOS` check; the `appVersion.value = await AppApi.GetVersion()` line; the `currentVersion` computed just below it; the new block immediately after `currentVersion` |
| `src/components/StatusBar.vue` | One new `isWeb = computed(() => WEB)`; one new `v-if="isLinux && visibility.headless"`-gated `<HeadlessServerStatus />` indicator plus its context-menu checkbox; `!isWeb` added to the `v-if`s (and matching context-menu checkboxes) for `steamvr`, `vrchat`, `nowPlaying`, `zoom`, and `proxy`; one new `v-if="isLinux || isWeb"`-gated `<UpdateCheckStatus />` indicator (no context-menu toggle — it hides itself entirely when there's nothing to report, so there's no persistent state worth letting a user turn off) | All the actual server-list UI lives in the new fork-owned `HeadlessServerStatus.vue` (seam table) — this file only gained the one slot + toggle, same shape as every existing indicator. Same reasoning for `UpdateCheckStatus.vue`. The `isWeb` prunes can't be aliased: they're `v-if`s on markup that already exists, not a swappable module | the `<HeadlessServerStatus />`/`<UpdateCheckStatus />` lines right before the `proxy` `TooltipWrapper`; `isWeb` beside the existing `isLinux`/`isMacOS` computeds; each pruned indicator's own `v-if`; the matching `ContextMenuCheckboxItem`s |
| `src/components/statusBarUtils.js` | One `headless: true` added to `defaultVisibility` | Same object every other indicator's default lives in | `defaultVisibility` |
| `eslint.config.mjs` | `WEB: 'readonly'` added beside the existing `WINDOWS`/`LINUX` globals. Later (2026-08-24): `updateService: 'readonly'` added the same way | Lint config can't be aliased. Found live: `WEB` was already referenced in `src/stores/vrcx.js`/`src/plugins/interopApi.js` (both pre-existing) without ever being registered here — `pnpm run lint` was silently broken on those two files before this change. `updateService` is the new bare global backing the fork-updater's server-driven update check (`client-desktop/shims/update-service.js`, §9's own write-up) — same class of gap, `src/stores/vrcxUpdater.js`'s new `typeof updateService` reference would otherwise fail `no-undef` | the `globals` object's `WINDOWS`/`LINUX` lines |
| `vitest.config.js` | `WEB: JSON.stringify(false)` added to the `define` block. Later (2026-08-23): `VERSION: JSON.stringify('2026.01.01')` added the same way | Test config can't be aliased; without it, mounting `StatusBar.vue` under test throws `ReferenceError: WEB is not defined` the moment `isWeb`'s computed runs. `VERSION` needed once `src/stores/vrcxUpdater.js` started referencing the bare global directly (see that file's own entry) — real `vite.config.js` already defines it for every platform, but nothing under `src/stores`/`src/components` had read it as a bare identifier before, so `vitest.config.js`'s own `define` block had never needed it either | `define`, beside `WINDOWS`/`LINUX` |
| `src/views/Settings/components/Tabs/SystemTab.vue` | (2026-08-23) New `isRealLinux` computed, `navigator.platform`-based (same pattern as the existing `isMacOS` computed right above it) rather than the `LINUX` compile flag; the `.desktop`-file autostart hint (`t('...startup_linux')`) is now only shown when `isRealLinux`, `undefined` (hidden, `SettingsItem`'s own `v-if="description"`) otherwise. New "Based on VRCX version" row (`upstreamVersion` from the store) right below the existing "Version" row. Removed the "Support" row (`links.discord`) entirely. Also gained `v-if="!noUpdater"` on the General section's "Latest Version" row — found live the same day: that row's `@click="checkForVRCXUpdate"` was unguarded (unlike the separate "VRCX Updater" section below it, already `noUpdater`-gated), so it still queried upstream's own `api0.vrcx.app` and displayed upstream's release name on click even with the self-updater otherwise disabled (`.no-updater`, §9). Later (2026-08-24): new "Fork Update" `SettingsGroup`, `v-if="isLinux"`, entirely separate from the "VRCX Updater" group above and not gated by `noUpdater` — shows `forkUpdateStatus`/`forkServerVersion`/`installedForkVersion` and a "Retry" button (`checkForForkUpdate({force: true})`) for the server-driven fork-updater, §9's own write-up has the full design | `LINUX` means "this is the Electron build" (§1's "Desktop client OS support"), not "running on Linux" — the Electron client also runs on Windows/macOS now, where telling a user to edit a `VRCX.desktop` file is nonsensical; needs the real host OS. The version rows, the Support-link removal, and the `noUpdater` gate are plain UI additions/removals with no smaller seam to alias through. The new "Fork Update" group is deliberately a separate block rather than folded into "VRCX Updater" — same reasoning as `.no-updater` itself, keeping the two flows from ever conflating | `isRealLinux` beside `isMacOS`; the `v-else` `SettingsItem`'s `:description` binding; the new "Based on VRCX version" `SettingsItem`; the removed "Support" `SettingsItem`; the "Latest Version" `div`'s `v-if="!noUpdater"`; the new "Fork Update" `SettingsGroup` right after the "VRCX Updater" one |
| `src/components/nav-menu/NavMenu.vue` (+ its test) | (2026-08-23) Reads `currentVersion` from `vrcxUpdaterStore` instead of `appVersion`, and the footer version badge's computed now splits `currentVersion` instead of `appVersion`. `openGithub()` now opens `links.github` (this fork's repo, `link.js`'s entry) instead of a hardcoded `https://github.com/vrcx-team/VRCX` — found live the same day as the `link.js` change: this handler was a second, separate hardcoded copy of the upstream URL that the `links.github` retarget didn't touch, so the "Manage" nav dropdown's logo/title click (`NavMenuFooter.vue`'s `@open-github`) still opened upstream's repo after that change | `appVersion` now carries this fork's own branding/version (`VRCX Headless <fork-version>`, see `src-electron/main.js`'s entry) — splitting *that* on `'VRCX '` would show `Headless <fork-version>` in the small footer badge. `currentVersion` is the store's own already-brand-stripped computed (`vrcxUpdater.js`'s entry), so reusing it here needs no new parsing logic. `openGithub` reusing `links.github` needs no new seam — it's the same constant `SystemTab.vue` already uses | the `storeToRefs(VRCXUpdaterStore)` destructure; the `version` computed; `openGithub()` |
| `src/components/nav-menu/NavMenuFooter.vue` | (2026-08-23) The "Manage" nav dropdown's header (logo + app name, `@open-github`) now reads "VRCX Headless" instead of plain "VRCX". Removed the "Help & Support" dropdown's Discord entry (`emit('support-link', 'discord')`) | Found live: with `discord` removed from `link.js` (that file's own entry, driven by removing the Settings page's Support row), `NavMenu.vue`'s `handleSupportLink('discord')` silently no-opped (`links[id]` undefined, guarded by `if (target)`) rather than crashing — a dead menu item is still wrong, so it was removed outright to match the Settings-page decision rather than left clickable-but-broken. The plain "VRCX" header text is the same in-app-branding gap as `SystemTab.vue`'s old "(Linux)" version prefix, just a different screen a user found it on | the "VRCX Headless" text beside the logo; the removed Discord `DropdownMenuItem` |
| `src/shared/constants/link.js` | (2026-08-23) `github` retargeted from `https://github.com/vrcx-team/VRCX` to `https://github.com/WentTheFox/VRCX-Headless`; `discord` key removed entirely (its one caller, `SystemTab.vue`'s "Support" row, was removed in the same pass — see that file's own entry) | Fork branding — this fork's Settings page should point at its own repository, not upstream's, and has no support Discord of its own to link | the `links` object |
| `src/localization/en.json` | (2026-08-23) New `view.settings.general.general.upstream_version: "Based on VRCX version"` key; `view.settings.general.general.support` key removed (its one reference, `SystemTab.vue`'s "Support" row, is gone — see that file's own entry). `view.settings.general.vrcx_updater.updater_disabled` reworded from upstream's "Updater disabled, updates are handled by your package manager." (accurate for e.g. a distro-packaged install, never true here) to pointing at the project's GitHub releases page — this fork has no package-manager install path live yet (the AUR package, §10, is built but dormant until `aur.archlinux.org` registration happens). `nav_menu.github` reworded from "VRCX on GitHub" to "VRCX Headless on GitHub"; `nav_menu.discord` key removed (its one reference, `NavMenuFooter.vue`'s Discord dropdown item, is gone — see that file's own entry). Later (2026-08-24): new `view.settings.general.fork_update.*` keys (`header`/`status`/`idle`/`checking`/`in_sync`/`installing`/`mismatch`/`retry`) for the new Settings section, and three new `message.vrcx_updater.fork_*` keys (`fork_check_failed`/`fork_mismatch`/`fork_install_failed`) for its toasts | Only `en.json` was touched — every other locale file's now-unused `support`/`discord` keys are inert (never referenced) and vue-i18n's `fallbackLocale: 'en'` covers the new/reworded keys for every language that hasn't translated them yet, so there's no functional gap, just an untranslated string on non-English locales until someone does | the `general.general` block under `view.settings`; `vrcx_updater.updater_disabled`; `nav_menu.github`/`nav_menu.discord`; the new `general.fork_update` block; `message.vrcx_updater`'s three new `fork_*` keys |
| `.github/workflows/github_actions.yml` | `npm ci`/`npm run X` → `pnpm install --frozen-lockfile`/`pnpm run X`, `actions/setup-node`'s manual npm-cache-directory dance replaced with `pnpm/action-setup` + `cache: pnpm` (2026-08-17 pnpm migration); every `uses:` pinned to an exact commit SHA with a trailing `# vX` comment (2026-08-17 SHA-pinning, same convention as every fork-owned workflow, see below) | Deliberately touched despite this file being upstream's own untouched Windows/CefSharp + Azure-signing pipeline (§9) — leaving it on `npm ci` after `package-lock.json` was deleted would silently break it outright, worse than the small diff; the SHA-pinning is the same supply-chain reasoning applied uniformly, not something specific to this file. Every *job* (the actual signing/build steps) stayed untouched | the `Restore dependencies`/`Get npm cache directory`/`npm-cache` steps in both the Linux and macOS build jobs; every `uses:` line |
| `.gitattributes` | `* text=auto` → `* text=auto eol=lf` (2026-08-18) | Found live: a contributor with `core.autocrlf=true` in their **global** `~/.gitconfig` (common on Windows/Git-Bash setups) checked out every text file — including `build-scripts/generate-self-signed-certs.sh` — as CRLF despite the repo's committed blobs being LF-only. A `#!/bin/bash\r` shebang makes the kernel look for an interpreter literally named `/bin/bash\r`, which doesn't exist (`cannot execute: required file not found`); even bypassing the shebang with an explicit `bash script.sh` still broke, since `set -euo pipefail\r` parses `pipefail\r` as an invalid option name. `eol=lf` forces LF on checkout regardless of the cloning machine's `core.autocrlf`, so this can't recur. Also renormalized the working tree's ~1300 already-checked-out CRLF files to LF via `sed -i 's/\r$//'` (bytes only — the committed blobs were already LF, confirmed by matching `git hash-object` before and after) | the `* text=auto` line at the top |

`src/App.vue` needed **no edit** — the server-login gate lives entirely in `client-web/**`; `src/app.js` top-level-awaits and mounts with no hook to gate on inside `App.vue` itself. `Dotnet/**` is modified only where this table says so (`Dotnet/AppApi/Electron/GameHandler.cs`, `Dotnet/VRCX-Electron.csproj`) — everything else under `Dotnet/**` remains untouched. Nothing else under `src/`, `Dotnet/`, or `src-electron/` has been modified.

</details>

---

## 6. Upstream sync procedure

Upstream's default branch is **`master`**; ours is **`main`**. The `upstream` remote is `https://github.com/vrcx-team/VRCX.git`.

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
- [ ] **`handlePipeline` gained event types?** New cases must be forwarded on the client stream.
- [ ] **`Dotnet/WebApi.cs` changed?** `git diff main..upstream/master -- Dotnet/WebApi.cs src/services/webapi.js`. The cookie blob format, the `data:image/png;base64,` prefix, header rules, and the `-1` sentinel are all mirrored in `server/src/shims/webapi.js` and `server/src/cookies.js`.
- [ ] **New `src/plugins/index.js`/`router.js` importers** in stores/coordinators? Those two aliases are what keep the component/view tree out of the server closure.
- [ ] **New npm dependency in the server's closure?** Add to `server/package.json` *and* root, or the container fails at runtime while dev works. `node server/scripts/check-deps.js` catches version mismatches.
- [ ] **New browser global used at module or store-setup scope?** Fails at import time in Node, not call time. See §3.7.
- [ ] **A `database.*` method now returns a `Map`/`Set`?** `JSON.stringify` silently drops them (`{}`); `server/src/http-server.js`'s `sendJson` replacer already converts both to arrays generically, but confirm the new method is actually routed through `sendJson`.
- [ ] **Reset `server/VERSION` to `1`.** The synced-to tag just changed the major component of the next server/Docker release version (§10's "Server/Docker versioning") — the fork's own counter restarts against the new base.

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

- **Single account.** `dbVars.userPrefix` names tables per VRChat account and is a mutable global set at login. One server process serves one account.
- **Two settings stores.** `configRepository` (SQLite) moves to the server; `VRCXStorage` (`VRCX.json`) is machine-local and desktop-side. The web client gets a `localStorage`-backed stub (`client-web/shims/vrcx-storage.js`) — not full parity, since a browser tab has no analogue for e.g. window geometry.
- **`AppApi` capability coverage is not exhaustive** in the web client (`client-web/shims/app-api.js`) — everything unimplemented throws (and toasts) "not available in the web client". The remainder is genuinely native-only: VR overlay, Discord RPC, registry, screenshots, `CopyImageToClipboard(path)`. Game launch (`StartGame`/`StartGameFromPath`) is the one exception, found live (2026-08-18): both hand off to the same `vrchat://launch` deep link vrchat.com's own "Launch" button uses (built by the unmodified `src/stores/launch.js`), relying on the OS protocol handler to reach a local VRChat/Steam install — no VRChat autodetection, custom launch arguments, or forced VR/desktop mode, since a browser can pass through only the bare URL. `AssetBundleManager` (`client-web/shims/asset-bundle-manager.js`) is the same story as `LogWatcher`: not part of `AppApi` at all, but reached unconditionally from `checkVRChatCache()` on every world/avatar dialog open, so it's stubbed ("nothing cached") rather than left to throw a bare `ReferenceError`.
- **`speechSynthesis` is a permanent stub everywhere.** The agent channel (phase 5) is request/response, not a fit for routing an ongoing audio stream.
- **One desktop agent at a time.** A second Electron instance connecting to the same server replaces the first agent's connection rather than fanning out to both.
- **No server lifecycle management on the desktop side.** The Electron client never starts a `serve` instance itself ("always external" by design); if one isn't running at all when the client launches, it falls back to `client-desktop/setup.html`. A `serve` *restart* no longer forces this, though — session tokens survive a restart and refresh to stay logged in indefinitely (`server/src/http-auth.js`, `POST /api/session/refresh`).
- **The bundled `.NET`/`node-api-dotnet` footprint hasn't been shrunk.** `AppApiElectron`/`Discord`/`LogWatcher`/`AssetBundleManager`/`AppApiVrElectron` are all real, in-process .NET objects the renderer calls directly; only `SQLite`/`WebApi` were dropped. `.github/workflows/github_actions.yml` (the full, signed release pipeline) is still upstream's own Windows/CefSharp + Azure-signing workflow — its actual *jobs* remain untouched, only its npm→pnpm commands were updated alongside every other workflow in the 2026-08-17 pnpm migration (§5), since letting it silently break was worse than the small diff. `.github/workflows/client-desktop.yaml` (fork-owned, build+smoke-test only, no signing) covers CI verification of the Linux Electron build instead — see also `desktop-release.yaml` (§10) for the real cross-platform, signed release pipeline.
- **The single-writer lock (phase 6) only protects this fork's own processes against each other**, not an old unmodified upstream desktop build opening the same `VRCX.sqlite3` directly. The "don't run both at once" warning in `server/README.md` still applies.
- **Test coverage upstream is thin at the seam.** One test covers ~190 repository methods (`src/services/database/__tests__/gameLog.test.js`). `server/test/db.test.js` is the closest thing to a migration regression test.
- **Node version.** Root `package.json` requires Node ≥24.15; the server itself only needs ≥22.5 (for `node:sqlite` with `setReturnArrays`).
- **The desktop client's built-in self-updater is permanently disabled**, via a new, deliberately empty `.no-updater` file at the repo root (already in `electron-builder.config.js`'s `files` allowlist, so every packaged build bundles it — upstream itself defines this exact marker-file mechanism, `src-electron/main.js`'s `const noUpdater = args.includes('--no-updater') || fs.existsSync(path.join(rootDir, '.no-updater'))`, this fork just never populated it before 2026-08-23). Found live: with no marker file present, the "VRCX Updater" section of Settings was fully active and pointed at `api0.vrcx.app` (`src/shared/constants/settings.js`'s `branches[...].urlLatest`) — upstream's own proprietary release channel, entirely unrelated to this fork's actual releases (GitHub Releases + AUR, §10). Left enabled, "Auto Download" would silently fetch and install a genuine upstream VRCX build over a fork install — overwriting the split architecture (native SQLite/WebApi, no headless-server awareness) with no warning. `noUpdater` already gates the whole "VRCX Updater" UI section (`SystemTab.vue`'s `updater_disabled` message) and the update-check calls driven from `initVRCXUpdaterSettings` (`vrcxUpdater.js`), and `isMacOS`/`HEADLESS` were already using the same flag for the same reason; the one gap was the General section's standalone "Latest Version" row, whose `@click="checkForVRCXUpdate"` wasn't gated at all — now also `v-if="!noUpdater"` (that file's own patch-inventory entry). **Deliberately kept disabled rather than repointed at this fork's own releases** — `checkForVRCXUpdate`'s response-shape assumptions (`json.name`/`json.published_at`/`json.assets`, `getAssetOfInterest`) are `api0.vrcx.app`'s own API contract, not GitHub Releases', and `releaseName > currentVersion.value` is a bare string comparison that only orders correctly by luck; a real fork-updater needs its own endpoint (or a GitHub-Releases-shaped adapter) and its own version-comparison logic against this fork's `<vrcx-date>.<fork-build>.0` scheme, not a quick repoint.

  **(2026-08-24) That fork-updater now exists**, entirely additive — `checkForVRCXUpdate`/`getAssetOfInterest`/`downloadVRCXUpdate`/`branches` above are still completely untouched and still permanently dormant behind `.no-updater`; nothing about this bullet changed. The new flow is server-driven: the desktop client asks its *connected server* for its own version and the matching GitHub release (`server/src/update-release.js`'s `getUpdateInfo()`, a new `update` RPC target in `server/src/rpc.js`), rather than checking "whatever's newest on GitHub" — the server and desktop client are released together under one tag, so a client should track the specific server it's talking to, not drift ahead of or behind it. On a version mismatch with a published release available, the client downloads, SHA256-verifies, and installs **fully automatically** (reusing `Dotnet/Update.cs`'s existing, unmodified download/verify/install machinery via `AppApi.DownloadUpdate`) and restarts itself — no confirmation click, per explicit user decision. If the check itself fails (old server without the RPC target, network issue) or no matching release is published yet, it just warns that the client/server versions may be mismatched rather than looping or crashing. Windows-only for now; extending to Linux is one more branch in `getForkAssetOfInterest` (`vrcxUpdater.js`) matching upstream's own `.AppImage` selection immediately above it — everything else (RPC, server, `Dotnet/Update.cs`'s AppImage in-place-swap path) is already OS-agnostic. Triggered from `src/components/HeadlessServerStatus.vue` (fork-owned, not upstream) on every "server became reachable" edge — which already covers both a fresh connect and a server switch, since `vrcx-switch-server` (`src-electron/main.js`) restarts the whole Electron process. New UI: a separate "Fork Update" `SettingsGroup` in `SystemTab.vue`, `v-if="isLinux"`, entirely independent of the "VRCX Updater" group and its `noUpdater` gate above.

---

## 10. The container

`server/Dockerfile` (build context is the **repo root**, not `server/`), published by `.github/workflows/server-docker.yaml` to `ghcr.io/<owner>/vrcx-headless-server` for `linux/amd64` and `linux/arm64`. User-facing docs: `server/README.md`.

**Design notes:** the image installs `server/package.json`, not the root manifest — the root keeps everything in `devDependencies`, while the image layout (`/app/{node_modules,src,server}`) mirrors a dev checkout so Node resolves `src/**`'s bare imports upward exactly as locally. Dependency versions are stated twice as a result, checked by `server/scripts/check-deps.js` in CI. Every dependency is pure JS (`node:sqlite` is built into the Node binary), so Alpine/musl is safe and the arm64 build under QEMU is cheap. A third, discarded build stage runs `pnpm run prod-web` to produce the bundled web client under `build/html-web`, pinned to `--platform=$BUILDPLATFORM` so the multi-arch CI build produces it once, not once per target arch. CI builds the native-arch image, smoke-tests it (`migrate --create`, `--help`, and a real `serve` boot checking both `GET /` and `/api/*` routing) before publishing.

### Server/Docker versioning

**The release version is real semver with the VRCX base as the major component**: `<vrcx-date-no-dots>.<fork-build>.0` — e.g. `20260718.1.0` for the first fork release built against VRCX 2026.07.18. The VRCX version is the version, not a footnote buried in build metadata (an earlier iteration of this scheme did exactly that, `<fork>+vrcx.<vrcx>`, and got corrected before it ever shipped for burying the one thing this was supposed to surface).

Two source files, two different reasons to change:

- **`server/VERSION`** — this fork's own release counter, a bare integer (`1`, `2`, …). Bumped on every server/Docker release that's worth tagging; **reset to `1` on every upstream sync** (§6), since a new VRCX base restarts the count. `server/src/globals.js`'s `readForkVersion()` reads it.
- **`Version`** (repo root, existing, untouched) — upstream's own date tag, already the source of truth for the Electron client's version stamp and the real VRChat user-agent string (`readVersion()` — do not repurpose that function for this).

`buildServerVersion(forkVersion, vrcxVersion)` (`server/src/globals.js`) combines them — strips `Version`'s dots (`2026.07.18` → `20260718`) and joins as `<that>.<fork>.0`. Safe as a bare semver major with no leading-zero problem for the foreseeable future (the leading digit is the year's own leading digit, non-zero until year 10000), and — being fixed-width `YYYYMMDD` — it also sorts correctly as a plain integer across dates, so nothing downstream needs real semver-aware comparison to get "which is newer" right. Printed by `pnpm run server -- info` (`server version` line, alongside the dotted `Version` for readability) and baked into the image as the `org.opencontainers.image.version` label (`server/Dockerfile`'s `SERVER_VERSION` build `ARG`, computed the same way in `.github/workflows/server-docker.yaml`'s `version` step — shell `tr -d '.'` mirroring the JS `replaceAll('.', '')`).

**Release trigger is a git tag, deliberately** — `git tag v<vrcx-no-dots>.<fork>.0 && git push --tags` is what publishes the immutable, pinned Docker tags: this reuses the workflow's existing `on.push.tags: ['v*']` trigger and `docker/metadata-action`'s `type=semver` patterns as-is, no custom tag-generation logic needed since the version *is* real semver now. Every ordinary push to `main` (tagged or not) still publishes/updates the floating tags below.

Resulting Docker tags on `ghcr.io/<owner>/vrcx-headless-server`:

| Tag | Meaning | Updates on |
|---|---|---|
| `20260718.1.0` (`{{version}}`) | Immutable pin to one exact fork release | a matching tag push only |
| `20260718.1` (`{{major}}.{{minor}}`) | Floating latest patch of that fork build (`.0` today; only moves if this scheme ever grows true hotfix patches) | a matching tag push only |
| `20260718` (`{{major}}`) | Floating "latest fork build against this VRCX base" — what a `vrcx-<date>` bespoke tag would have been, gotten for free from semver instead | any tag push sharing that major |
| `latest` | Floating absolute latest | a tag push only |
| `main`, `sha-<short>` | Dev builds | every push to `main` |

#### Cutting a release

1. `cat server/VERSION` — if this release starts a **new upstream sync** (§6), set it to `1`; otherwise bump it by one from whatever it currently is.
2. Compute the tag: `echo "v$(cat Version | tr -d '.').$(cat server/VERSION).0"` — e.g. `v20260718.2.0`.
3. Commit the `server/VERSION` bump (if any) on `main` first, then tag *that* commit and push both:
   ```bash
   git tag -a v20260718.2.0 -m "..."
   git push origin v20260718.2.0
   ```
4. Watch it: `gh run list --workflow=server-docker.yaml` / `gh run watch <run-id>` — the same job that runs on every `main` push (tests, build, smoke tests) runs again for the tag push, then publishes the tags above.
5. If a tag push fails before the publish step (nothing was pushed to GHCR under it — verify via the run log, not by assumption), it's safe to fix forward and move the tag: `git tag -d vX.Y.Z.0 && git push origin :refs/tags/vX.Y.Z.0`, fix, re-tag, re-push. Once a tag push has actually reached the publish step, treat it as immutable instead — cut a new release rather than moving it.
6. The same tag push also triggers `.github/workflows/desktop-release.yaml` (below) — watch it the same way, `gh run list --workflow=desktop-release.yaml`.

#### Desktop client release artifacts

The same `v*` tag that cuts a Docker release also triggers **`.github/workflows/desktop-release.yaml`**: Windows and Linux build a full x64+arm64 matrix (`build` job, 4 legs, self-signed on Windows), macOS builds Apple Silicon only and ships **unsigned** (`build-macos` job, 1 leg), and all 5 artifacts — `VRCX-Headless_<fork-version>_<arch>.{AppImage,dmg}` for Linux/macOS, `VRCX Headless Setup <fork-version> (<arch>).exe` for Windows, where `<fork-version>` is the same `buildServerVersion()` scheme as the Docker tag (§10's "Server/Docker versioning") — attach to a **draft** GitHub Release for that tag. Windows uses a native-arm64 runner (`windows-11-arm`) rather than cross-compiling, for the same reason macOS uses a native Apple Silicon runner: `node-api-dotnet`'s prebuilt native binary must match the *target* arch, and `pnpm install`'s normal optionalDependency resolution only gets that right when it runs on a matching host.

**Draft, not published, deliberately.** This repo has GitHub's "Immutable releases" setting active — once a release is *published*, its assets can never be edited or replaced. Publish by hand from the GitHub UI after checking the artifacts. Switching to immediate-publish is a one-line change (drop `--draft` in the workflow's `publish-release` job) once the pipeline's proven reliable across a few more releases.

**Signing setup (one-time, per machine that will hold the secret):** run `build-scripts/generate-self-signed-certs.sh` locally to produce `codesign-windows.pfx` — a self-signed Windows Authenticode cert, `CN=WentTheFox, C=HU, ST=Pest, L=Budapest`, empty passphrase. Base64-encode it and set one GitHub Actions secret: `WIN_CSC_LINK`. No `WIN_CSC_KEY_PASSWORD` secret — Windows signing works correctly with that variable left unset. Self-signed means it reduces some SmartScreen friction (a real signature is present) but does **not** eliminate the "unidentified developer" warning. The `.pfx` file never gets committed — `.gitignore` blocks it by extension — and contains private key material regardless of the empty passphrase, so keep it off anywhere less trusted than the machine that generated it.

**`.NET` RID additions (additive only, per invariant 5):** `Dotnet/VRCX-Electron.csproj` and `Dotnet/VRCX-Electron-arm64.csproj` gained `win-x64;osx-x64` and `win-arm64;osx-arm64` respectively, alongside their existing `linux-x64;linux-arm64`. The Linux-side `<RuntimeIdentifier>` default and `<DefineConstants>LINUX</DefineConstants>` are both untouched — that define is the "this is an Electron build" flag (`Dotnet/Program.cs`'s `#if LINUX` around the entire `ProgramElectron` class), not an OS flag, and must stay set for every RID including Windows/macOS. RID selection for a given CI leg happens via an explicit `-r <rid>` flag on the `dotnet build` command, not by changing any default.

**macOS is Apple Silicon only and ships unsigned, both permanent, not open items.** `macos-x64`/`macos-13` runners never reliably dispatch on this account (confirmed not a billing/plan gate, the repo is public) — retry rather than assume a workflow bug if a real release stalls on the macOS leg. Unsigned is a harder limitation: a self-signed PKCS12 can be imported into a macOS keychain (needs explicit `-certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1` on export, since OpenSSL 3.x's modern default encryption fails macOS's `security import` regardless of password), but electron-builder's own identity-discovery preflight then refuses to use it anyway — macOS flags any cert with no trusted CA chain as `CSSMERR_TP_NOT_TRUSTED`, which every self-signed cert always is, and electron-builder has no config option to override that check. A real fix means bypassing its built-in mac signing entirely (manual keychain trust + direct `codesign`) — out of scope. `build-scripts/generate-self-signed-certs.sh` only generates the Windows cert; there's nothing for macOS to sign.

`Dotnet/AppApi/Electron/**` still has zero macOS branching regardless of signing — folder ops, VRChat autodetect/launch, and overlay remain expected-broken on macOS until someone does for it what `GameHandler.cs` already got for Windows.

#### AUR package

`aur/vrcx-headless-bin/` (PKGBUILD, desktop entry, icon) plus **`.github/workflows/aur-publish.yaml`** publish a `vrcx-headless-bin` package to the AUR, wrapping the released x64 AppImage — AUR is x86_64-only (Arch proper only supports that architecture), so there's no arm64 equivalent to publish. Triggers on a GitHub Release actually being *published* (not the tag push that only creates the draft), rewrites the PKGBUILD's `pkgver`/`sha256sums` with the real release's values, regenerates `.SRCINFO`, and pushes to the AUR git remote over SSH. Needs an `AUR_SSH_PRIVATE_KEY` secret tied to a real AUR account (aur.archlinux.org) — the workflow no-ops with a log message if that secret isn't set, so it's safe to leave dormant until that account exists. The first successful push also creates the AUR package itself; no separate manual bootstrap.
