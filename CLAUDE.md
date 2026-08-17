# VRCX-Headless — fork architecture and upstream migration guide

This fork splits [VRCX](https://github.com/vrcx-team/VRCX) into two pieces:

- a **headless server** that owns the VRChat API connection and is the *sole writer* of `VRCX.sqlite3`
- a **client** — the existing Vue app — that runs either in a browser or inside the Electron desktop shell, and stays in sync across devices off a server event stream

Upstream is a fast-moving, UI-heavy project, and `.github/CONTRIBUTING.md` says UI PRs are declined there, so **everything we diverge on is permanently ours to maintain**. This document exists to make each upstream merge mechanical rather than archaeological.

**If you are an agent or contributor about to change something: read "Invariants" first. They are the whole reason this fork is maintainable.**

**Status (2026-08-17):** All six roadmap phases plus TOTP auth and the Groups-sidebar relay are implemented and verified — server-side by the test suite (`npm run test:server`), client-side by real browser/desktop passes (Chrome via Claude in Chrome; a real Electron build against a real `serve` instance). Phase 5's live desktop pass confirmed connection, auth, RPC (db/config/webapi), and app boot, found and fixed five real bugs in the process, and a second pass confirmed the Discord-RPC-over-agent-channel mechanism specifically (real agent connection, real `Discord.SetActive` round-trip, no errors) — the one thing still open is a *visible* Rich Presence, which needs the account actually in a live VRChat world, not achievable from a build/CI sandbox (see §8). `.github/workflows/client-desktop.yaml` now gives the Electron build its own fork-owned CI (build + boot smoke-test, no signing). Everything else in §9 "Known limitations" is a deliberate scope cut, not unfinished work. §8 collapses each phase to what shipped and what merges should watch for — expand it for the roadmap narrative, not for merge mechanics; those live in §2–§6.

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
6. **Every unavoidable `src/` edit gets an entry in §5**, with enough anchor context to re-find it after upstream reformats the file. If §5 passes ~15 entries, convert edits back into aliases.

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
| SQL transport | `src/services/sqlite.js` | 2 methods; the **only** `window.SQLite` caller | real `node:sqlite` via `server/src/shims/sqlite.js` | unused once DB/config are aliased away (verified: no `SQLite.Execute`/`handleSQLiteError` in the built client) | same, verified in `npm run prod-linux` output |
| DB repository | `src/services/database/index.js` | flat ~190-method facade, 206 call sites | imported unmodified | `Proxy` → `rpc('db', name, args)`, `client-web/shims/database.js` | same shape over IPC instead of `fetch`, `client-desktop/shims/database.js` |
| Config KV | `src/services/config.js` | 13 methods, ~540 call sites | imported unmodified | RPC + write-through cache, `client-web/shims/config.js` | same, `client-desktop/shims/config.js` |
| VRChat HTTP | `src/services/webapi.js` | 4 methods; the **only** `window.WebApi` caller | `fetch` + tough-cookie via `server/src/shims/webapi.js` | proxied via server (`rpc.js`'s `webapi` target), `client-web/shims/webapi-target.js` | same target, `client-desktop/shims/webapi-target.js` |
| Pipeline WS | `src/services/websocket.js` | `handlePipeline` switch | runs unmodified | subscribes to server's `/api/stream` via an `AppDebug.websocketDomain` override (`client-web/bootstrap.js`), calls the same `handlePipeline` unmodified | not touched — the desktop renderer still connects straight to VRChat's real pipeline; only DB/config/webapi moved server-side |
| Daemon | `src/stores/updateLoop.js` | 1 Hz counter loop | runs here, and only here | no-op store, `client-web/shims/update-loop.js` | same, `client-desktop/shims/update-loop.js` |
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

Every modification to an upstream-owned file. Keep this exhaustive and keep it short — if it passes ~15 entries, convert edits back into aliases (invariant 6).

<details>
<summary>Full table (9 entries)</summary>

| File | Change | Why not an alias | Anchor |
|---|---|---|---|
| `package.json` | `name`/`description`/`homepage`/`bugs`/`repository` retargeted at the fork; `test:server`/`server` scripts; `tough-cookie`, `ws`, `qrcode-generator` dependencies (the last for client-side TOTP QR rendering); `dev-web`/`prod-web` scripts; `client-desktop/setup.html`/`setup.js` and `node_modules/qrcode-generator/dist/qrcode.js` added to the electron-builder `build.files` allowlist | Package identity and scripts can't be aliased. `tough-cookie`/`ws` are also real deps in `server/package.json` — `server/scripts/check-deps.js` enforces the two match. `build.files` entries are needed because only `build/html/**` ships in a packaged build by default; anything loaded standalone/unbundled must be listed explicitly | top-of-file metadata; `scripts`; `dependencies`/`devDependencies`; `build.files` array |
| `.github/workflows/ci.yaml` | Re-enabled the `pull_request` trigger (upstream ships it commented out) and added `push` on `main` | CI config can't be aliased | `on:` block at the top |
| `.gitignore` | Added `!CLAUDE.md` — upstream ignores AI guidance files, but this one is the fork's maintenance guide | Ignore rules can't be aliased | after the `AGENTS.md`/`AI_GUIDE.md`/`CLAUDE.md` lines |
| `README.md` | Added a short "About this fork" block pointing at `server/README.md` and this file | Docs can't be aliased; kept to a pointer since the real docs live in `server/README.md` | immediately before `# Getting Started` |
| `src/plugins/interopApi.js` | A third `else if (WEB)` branch beside `WINDOWS`/Electron, installing `client-web/shims/{webapi-target,app-api,vrcx-storage,log-watcher}.js`. The Electron branch swaps `window.WebApi` for `client-desktop/shims/webapi-target.js` and stops installing `window.SQLite`; `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager`/`AppApiVrElectron` stay the real `InteropApi.*` objects. Both `WEB` and Electron branches call `installUnhandledRejectionReporting()` (defined in this file) — reports failed RPC writes via the existing `vue-sonner` toast convention, skipping `WINDOWS`/CefSharp (no RPC hop there) and skipping any error already flagged `alreadyToasted` by `app-api.js`'s own toast-then-throw | This *is* the seam table's designated native-globals injection point | `if (WINDOWS) {...} else {...}` inside `initInteropApi`; `installUnhandledRejectionReporting` above it |
| `src/vite.config.js` | `WEB` added to the `define` block; a platform-conditional `resolve.alias` (`server/vite-alias-plugin.js`, reused for `PLATFORM === 'linux'` too via `client-desktop/aliases.js`); separate `outDir` per platform; dev-mode port/proxy branch; `publicDir` pinned explicitly to `src/public` (Vite otherwise defaults it relative to `root`, and neither client root has its own `public/`, silently dropping every asset under `src/public/**`) | Build config can't be aliased — this file *is* the alias mechanism for everything else | `define`; `plugins`; `server`/`build.outDir`/`build.rolldownOptions.input`; `publicDir` |
| `src-electron/main.js` | `SQLite`/`WebApi` .NET object `Init()` calls removed entirely. New IPC handlers: `vrcx-connect-server` (logs into a remote server, opens `/api/agent`, answers forwarded calls via the real `interopApi.callMethod`), `vrcx-rpc` (relays `database`/`config`/`webapi`), `vrcx-totp-setup`/`vrcx-totp-confirm`, `vrcx-get-stored-server-url`. A startup gate probes the stored session before loading the real app vs. `client-desktop/setup.html`. Also fixes a genuine pre-existing upstream bug (predates this fork, `74bae434`): `--x11` only skipped the auto-relaunch decision without telling Chromium to actually use X11, so on Wayland+Vulkan the window never became visible — now appends `ozone-platform=x11` to `app.commandLine` | `main.js`'s own boot sequence and IPC surface — nothing to alias, the point is changing what it does at startup; the ozone fix has no smaller seam to alias through | `interopApi.getDotNetObject(...)` block near the top; `const x11 = args.includes('--x11')`; the `ipcMain.handle(...)` calls; `createWindow()`'s `mainWindow.loadFile(...)` |
| `src-electron/preload.js` | A `vrcxDesktopAgent` `contextBridge.exposeInMainWorld` (`connectToServer`, `rpc`, `checkTotpSetupNeeded`, `confirmTotpSetup`, `getStoredServerUrl`) beside the existing `interopApi` one | Same reasoning as the `interopApi` bridge — a new IPC surface needs a new bridge entry | beside the existing `contextBridge.exposeInMainWorld('interopApi', ...)` call |
| `src/styles/globals.css` | One `@source '..';` line right after `@import 'tailwindcss';` | Tailwind v4's content detection scans relative to Vite's root; `client-web/`'s root is a *sibling* of `src/`, not an ancestor, so classes used only deep in `src/**` (e.g. `sr-only`) never made it into the web build. `@source` only works inside the same `@import` chain as `tailwindcss` itself — a plain JS `import` of a separate CSS file doesn't register. No-op for the desktop build | immediately after `@import 'tailwindcss';` |

`src/App.vue` needed **no edit** — the server-login gate lives entirely in `client-web/**`; `src/app.js` top-level-awaits and mounts with no hook to gate on inside `App.vue` itself. `Dotnet/**` remains fully unmodified. Nothing else under `src/`, `Dotnet/`, or `src-electron/` has been modified.

</details>

---

## 6. Upstream sync procedure

Upstream's default branch is **`master`**; ours is **`main`**. The `upstream` remote is `https://github.com/vrcx-team/VRCX.git`.

**Sync to upstream's latest tagged release, never to `master` HEAD.** Upstream tags releases `vYYYY.MM.DD` roughly every few weeks; `master` moves under an active, UI-heavy project between them, so merging HEAD turns every sync into a moving target instead of a discrete, reviewable step.

```bash
git fetch upstream --tags
git checkout -b sync/<tag> main
git merge v2026.07.18   # the tag being synced to, not upstream/master
```

Pick the tag deliberately — `git tag -l 'v*' | sort -V | tail -5` (or the [releases page](https://github.com/vrcx-team/VRCX/releases)) — rather than always grabbing the newest.

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

### 6.3 Verify before pushing the merge

```bash
npm ci
npm run test:server      # the split's own guarantees
npm test                 # upstream's suite must not regress
npm run lint && npm run format:check
node --import ./server/register-hooks.mjs server/src/cli.js info
```

Then, against a **copy** of a real database:

```bash
cp ~/.config/VRCX/VRCX.sqlite3 /tmp/parity.sqlite3
npm run server -- migrate --db=/tmp/parity.sqlite3
npm run server -- tables --db=/tmp/parity.sqlite3
```

Diff `sqlite_schema` against the same database migrated by the desktop build. They must be identical.

---

## 7. Server usage (current state)

Full setup and Docker instructions: **`server/README.md`**. Quick reference:

```bash
npm run server -- info                      # where the DB is, version, who is logged in
npm run server -- migrate [--user=usr_...]  # run the JS migration layer
npm run server -- tables                    # row counts per table
npm run server -- query "SELECT ..."        # read-only, positional rows
npm run server -- login                     # VRChat login, prompts for 2FA
npm run server -- whoami                    # check the stored session
npm run server -- pipeline                  # stream VRChat events
npm run server -- serve                     # HTTP/WS server for clients + agent
npm run server -- setup-totp                # (re)issue the serve auth secret
npm run test:server
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
| 4 | Web client: `PLATFORM=web`, `client-web/shims/**`, `capabilities` gating | done, live-browser verified |
| 5 | Desktop client as native agent: log forwarding up, overlay/Discord/notification commands down; .NET stops touching SQLite | done, live-desktop verified for connect/auth/RPC/boot/Discord-mechanism — a visible Rich Presence still needs a real VRChat world session (see §8) |
| 6 | Hardening: single-writer lock, awaited client writes, packaging | done |

Sections below are collapsed — expand for the "why", not to re-verify what the table above already states as done.

<details>
<summary><strong>Phases 0–2b: server core</strong></summary>

The server runs upstream's real `src/**` under Node via the alias/hook layer in §3, not a reimplementation. The two hardest problems, both solved and covered by tests: the 629-file store-graph closure (§4's "store-graph problem" — solved by aliasing exactly two import edges), and getting Pinia's `inject()`-based composables (`useRouter()`, `useI18n()`) to work outside a mounted component — nested `useXStore()` calls don't nest their injection context correctly, so `server/src/app.js` mounts a real (invisible) Vue component via `@vue/runtime-core`'s `createRenderer` rather than calling `createGlobalStores()` bare. Login is fully `watch()`-driven (`watchState`, `src/services/watchState.js`) with no imperative equivalent — `server/src/session.js`'s `waitForLogin` watches `watchState.isLoggedIn` rather than awaiting a promise. `updateLoop.js` runs as a real daemon, started once from the `pipeline`/`serve` commands, not from one-shot commands.

</details>

<details>
<summary><strong>Phase 3: transport</strong></summary>

`server/src/http-server.js` (raw `node:http`/`node:https` + the `ws` package) added `serve`: session/bearer-token auth (see the TOTP section below for the current mechanism), a generic `/api/rpc` dispatcher (`{target: 'db'|'config'|'webapi', method, args}` → the matching flat method-bag object, guarded by `method in Object.prototype` to block `constructor`/`__proto__`/etc.), and `/api/stream` — a `WebSocket` subclass tap (`installPipelineRelayPolyfill`) that relays every real pipeline frame verbatim, since the pipeline connection is the *only* `new WebSocket()` call site in the server's closure. Opt-in HTTPS via `--tls-cert`/`--tls-key`.

</details>

<details>
<summary><strong>Phase 4: web client</strong></summary>

`client-web/**` + a `PLATFORM=web` Vite branch. Far less aliasing was needed than the server required — a real browser has Web Workers and dialogs, so only the DB/config/webapi/updateLoop seams (§4) survive. `client-web/bootstrap.js` renders a login form, then `import()`s the real, unmodified `src/app.js` once a session exists — no `App.vue` edit needed. `window.WebApi`/`AppApi`/`VRCXStorage` are RPC-backed shims installed via a new `WEB` branch in `interopApi.js`; `AppApi` **throws** on anything unimplemented (the opposite default from the server's silent no-op), so a human watching the screen gets a visible failure instead of a silent one.

Bugs found and fixed during the live-browser pass, kept because they're the kind a future merge could reintroduce: a blank `#root` (unconditional `AppApi.ChangeTheme`/`CustomCss` boot calls need to be real, not throw); a stub store missing five real methods call sites needed directly, not just the one traced first (fix generalizes: **a stub must match a store's whole public surface**, not one call site); a trailing-slash mismatch on the `/api/stream` WS upgrade path; a `Map`/`Set`-over-JSON data-loss bug affecting ~15 `database.*` methods, fixed generically in `sendJson`'s `JSON.stringify` replacer (see the §6.2 checklist item); and `Execute()` in the webapi RPC shim letting a plain `Error` propagate instead of the `{Item1, Item2}` tuple its own contract requires. Also: Tailwind v4 needs an explicit `@source '..';` (§5) and Vite's `publicDir` must be pinned (§5) — both because `client-web/`'s root is a sibling of `src/`, not an ancestor.

</details>

<details>
<summary><strong>Phase 5: desktop client as native agent</strong></summary>

Decided up front: **"always external"** — the Electron build never spawns a `serve` instance itself, only ever connects to one running elsewhere. Far less native-capability surface needed reimplementing than the phase name suggests: VR overlay/Discord/log-tailing/registry never touched the database or VRChat's API, so the renderer's existing direct native calls (`src-electron/InteropApi.js`, `src/ipc-electron/interopApi.js`) keep working untouched. Only `window.SQLite` and `window.WebApi` needed to stop being real .NET objects. `server/src/agent.js` tracks at most one connected desktop agent and relays `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager` calls to it over `/api/agent`, terminating in the same `interopApi.callMethod` the renderer's own native calls already use. `client-desktop/**` mirrors `client-web/**`'s RPC shims, routed through `window.vrcxDesktopAgent.rpc` (main-process-mediated, avoiding renderer CORS) instead of `fetch`.

Bugs found on the first live desktop pass (2026-08-15), all fixed — kept because each is a gotcha a future platform/agent change could reintroduce: `WebApi.ExecuteJson` (the Electron-only JSON-in/out call path `webapi.js` branches to on `LINUX`) didn't exist in the shim, only `Execute`; `ws` was in `devDependencies`, which electron-builder prunes from the packaged app; the agent-aware `AppApi` polyfill forwarded the literal (abstract, non-instantiable) class name `'AppApi'` instead of the concrete `AppApiElectron` main.js's own native calls resolve to; the server URL wasn't persisted for re-entry on `serve` restart (sessions are process-lifetime only); and `--x11` never actually told Chromium to use X11 (a genuine pre-upstream bug, §5's patch inventory).

**Discord RPC over the agent channel — live-verified (2026-08-17), mechanism confirmed, full visible presence still open.** Built the .NET side (`dotnet build Dotnet/VRCX-Electron.csproj`), the Vue app (`npm run prod-linux`), and packaged a real AppImage (`npm run build-electron`) — all three commands work as documented, and this pass is what confirmed `.github/workflows/client-desktop.yaml`'s steps are correct, not just plausible. Ran the real AppImage against a real `serve` instance (paired by minting a TOTP code from the stored secret and writing a fresh bearer token into `VRCX.json`, rather than driving the setup UI — no GUI-automation tool available for an arbitrary Electron window, only for Chrome) with a real Discord client running locally. Confirmed live: the agent WebSocket connects (`Connected to server agent channel`); `Discord.Instance.Init()` is called from `src-electron/main.js` on Electron boot (starting the native class's internal 3s update timer — `Dotnet/Program.cs`'s CefSharp-only `Run()` never runs on this platform, so this JS-side call is the *only* thing that starts it); and `updateLoop.js`'s periodic `Discord.SetActive(...)` call round-trips through `server/src/agent.js` → the WS → `interopApi.callMethod` → the real `Dotnet/Discord.cs` object with no errors anywhere in either process's logs. What's still unconfirmed: a *visible* Rich Presence, which `Discord.cs`'s own `Update()` deliberately only attempts once `_active` is true — and `discordPresence.js` only computes `active = true` for a real (non-offline) VRChat instance, which needs the account actually in a live world, not achievable from this pass alone. Two real environment gotchas found and folded into the CI workflow: the AppImage needs FUSE to run directly, not guaranteed present (worked around with `--appimage-extract-and-run`, no package install needed) — and the app relocates/renames its own file to `~/Applications` on first launch (real `VRCX.Update` behaviour, not fork-added), so the workflow uploads the build artifact *before* the boot smoke test, not after.

</details>

<details>
<summary><strong>TOTP auth</strong></summary>

Replaced phase 3's static password with RFC 6238 TOTP (`server/src/totp.js`, `node:crypto` only, verified against RFC 6238 Appendix B's published test vectors) — the rotating code is worthless outside its ~60s window even if sniffed, unlike an indefinitely-reusable static password. `POST /api/totp/setup` + `/confirm` are one-shot: once a secret exists, the QR/secret can never be shown again in a browser, only rotated via the `setup-totp` CLI command (shell access is the trust boundary). Both clients gained a first-run QR-enrollment screen (`qrcode-generator`, loaded as a plain classic `<script>` on the no-build desktop `setup.html`). `serve` now boots even with no secret configured (logs a warning) specifically so first-run browser enrollment is reachable at all — every route except the two TOTP ones and static serving still requires a session, so nothing is exposed by starting unconfigured.

</details>

<details>
<summary><strong>Phase 6: hardening</strong></summary>

**Single-writer lock** (`server/src/lock.js`, genuinely new code): a hand-rolled PID lockfile (`fs.openSync(path, 'wx')`, atomic exclusive-create) since SQLite's own `locking_mode=NORMAL` (needed so short commands can coexist with a running `serve`) gives no exclusivity signal to build on. `serve`/`pipeline` acquire it and release on clean exit; `migrate` refuses against a locked DB unless `--force`. Only protects this fork's own processes against each other — an old unmodified upstream desktop build has no idea the convention exists.

**Awaited client writes** — audited, not rewritten: all 86 un-awaited `database.*`/`configRepository.*` call sites are upstream's own by-design fire-and-forget writes, zero correctness bugs found. The real gap was that a failed write was completely silent on the RPC-backed clients; closed with one `unhandledrejection` → toast listener (`installUnhandledRejectionReporting`, §5).

**Packaging**: `client-desktop/README.md` documents the real two-stage build (`dotnet build` → `npm run prod-linux && npm run build-electron`), traced from `.github/workflows/github_actions.yml`'s CI job rather than invented, since that workflow itself has no fork-adapted equivalent (§9).

</details>

<details>
<summary><strong>Post-phase-6: AppApi toast-on-throw, history polyfill, Groups sidebar relay</strong></summary>

The web client's unimplemented-`AppApi` throws now also toast at the throw site (several call sites were swallowing them silently), with an `alreadyToasted` flag so this doesn't double up with phase 6's own `unhandledrejection` listener for the one failure mode both can see.

A cosmetic `[VUE_ROUTER_R0011]` warning on every `serve` boot was vue-router's own `isBrowser` check misfiring against the `document` polyfill (§3.7) — fixed with a `history` polyfill (§3.7).

The Groups sidebar was empty on every client since phase 4: `groupStore.groupInstances` is populated only by `updateLoop.js`'s server-only poll, which never reached a client. `server/src/group-instance-relay.js` taps the one REST call that poll makes (at the WebApi shim seam, not an upstream call site) and relays it over the same `/api/stream` connection, shaped to look like an unrecognized pipeline frame type so `websocket.js`'s own unmodified `handlePipeline` just logs and ignores it — `client-web/bootstrap.js` taps the same `WebSocket` constructor a second, independent way to catch it and call the real `handleGroupUserInstances` directly. The relay also caches and replays its last frame to newly-connecting clients, since the underlying poll starts before the HTTP server does.

</details>

---

## 9. Known limitations

- **Single account.** `dbVars.userPrefix` names tables per VRChat account and is a mutable global set at login. One server process serves one account.
- **Two settings stores.** `configRepository` (SQLite) moves to the server; `VRCXStorage` (`VRCX.json`) is machine-local and desktop-side. The web client gets a `localStorage`-backed stub (`client-web/shims/vrcx-storage.js`) — not full parity, since a browser tab has no analogue for e.g. window geometry.
- **`AppApi` capability coverage is not exhaustive** in the web client (`client-web/shims/app-api.js`) — everything unimplemented throws (and now toasts, see §8) "not available in the web client". The remainder is genuinely native-only: VR overlay, Discord RPC, registry, screenshots, game launch, `CopyImageToClipboard(path)`.
- **`speechSynthesis` is a permanent stub everywhere.** The agent channel (phase 5) is request/response, not a fit for routing an ongoing audio stream.
- **One desktop agent at a time.** A second Electron instance connecting to the same server replaces the first agent's connection rather than fanning out to both.
- **No server lifecycle management on the desktop side.** The Electron client never starts a `serve` instance itself (phase 5's "always external" decision); if one isn't running or restarts mid-session (sessions are process-lifetime only), the desktop client falls back to `client-desktop/setup.html` on next launch.
- **The bundled `.NET`/`node-api-dotnet` footprint hasn't been shrunk.** `AppApiElectron`/`Discord`/`LogWatcher`/`AssetBundleManager`/`AppApiVrElectron` are all real, in-process .NET objects the renderer calls directly; only `SQLite`/`WebApi` were dropped. `.github/workflows/github_actions.yml` (the full, signed release pipeline) is still upstream's own Windows/CefSharp + Azure-signing workflow, untouched — `.github/workflows/client-desktop.yaml` (fork-owned, build+smoke-test only, no signing) covers CI verification of the Linux Electron build instead; see §8.
- **The single-writer lock (phase 6) only protects this fork's own processes against each other**, not an old unmodified upstream desktop build opening the same `VRCX.sqlite3` directly. The "don't run both at once" warning in `server/README.md` still applies.
- **Test coverage upstream is thin at the seam.** One test covers ~190 repository methods (`src/services/database/__tests__/gameLog.test.js`). `server/test/db.test.js` is the closest thing to a migration regression test.
- **Node version.** Root `package.json` requires Node ≥24.15; the server itself only needs ≥22.5 (for `node:sqlite` with `setReturnArrays`).

---

## 10. The container

`server/Dockerfile` (build context is the **repo root**, not `server/`), published by `.github/workflows/server-docker.yaml` to `ghcr.io/<owner>/vrcx-headless-server` for `linux/amd64` and `linux/arm64`. User-facing docs: `server/README.md`.

<details>
<summary>Design rationale</summary>

The image installs `server/package.json`, not the root manifest — the root keeps everything in `devDependencies` (so `--omit=dev` installs nothing, `--include=dev` drags in electron/vite), while the image layout (`/app/{node_modules,src,server}`) mirrors a dev checkout so Node resolves `src/**`'s bare imports upward exactly as locally. The cost: dependency versions are stated twice, checked by `server/scripts/check-deps.js` in CI. Every dependency is pure JS (`node:sqlite` is built into the Node binary) so there's nothing to compile — Alpine/musl is safe, and the arm64 build under QEMU is cheap. CI builds the native-arch image and smoke-tests it (`migrate --create`, `--help`) before publishing.

</details>
