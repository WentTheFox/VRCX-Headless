# VRCX-Headless — fork architecture and upstream migration guide

This fork splits [VRCX](https://github.com/vrcx-team/VRCX) into two pieces:

- a **headless server** that owns the VRChat API connection and is the *sole writer* of `VRCX.sqlite3`
- a **client** — the existing Vue app — that runs either in a browser or inside the Electron desktop shell, and stays in sync across devices off a server event stream

Upstream is a fast-moving, UI-heavy project, and `.github/CONTRIBUTING.md` says UI PRs are declined there, so **everything we diverge on is permanently ours to maintain**. This document exists to make each upstream merge mechanical rather than archaeological.

**If you are an agent or contributor about to change something: read "Invariants" first. They are the whole reason this fork is maintainable.**

**Status (2026-08-14):** Phases 0 through 4 are **done**, phase 4 now including a real in-browser pass (not just server-side curl/CLI). `login`, `whoami`, `logout` and `pipeline` all drive the real reactive stores (`src/stores/**`, `src/services/websocket.js`) rather than a bespoke scaffold, verified end-to-end against a real VRChat account in a real Linux + Steam + VRChat environment, which CI cannot do (`api.vrchat.cloud` isn't reachable from there). Phase 2b found and fixed several real bugs along the way — a pipeline WebSocket needs an explicit `User-Agent` header or Cloudflare drops the handshake silently (§3.7), a Pinia/Vue injection re-entrancy bug that only surfaces once stores compose each other outside a mounted component, and a narrowed `window` breaking bare-global reads unless writes through it mirror onto `globalThis`. Phase 3 (§8) had no pre-written recipe — just the roadmap's one-line spec — and added `serve`: password auth, a generic `/api/rpc` dispatcher over `database`/`configRepository`/`WebApi`, and `/api/stream` relaying the VRChat pipeline verbatim to connected clients, plus opt-in HTTPS (`--tls-cert`/`--tls-key`). Phase 4 (§8) got the real, unmodified Vue app building and running against `serve` from a browser — `client-web/**`, a `PLATFORM=web` Vite branch, a shared alias-resolution plugin that needed two real fixes, and — once actually opened in a browser — five more real bugs (a blank `#root`, a stub store missing five methods real call sites needed, a WebSocket path mismatch, and a `Map`-over-JSON data-loss bug affecting ~15 `database.*` methods), all found and fixed live (§8's own write-up has the details on both rounds). Phase 5 (§8) turns the Electron desktop client into a native agent of the server — it stops opening `VRCX.sqlite3`/talking to VRChat directly (`src-electron/main.js`'s `SQLite`/`WebApi` `.Init()` calls are gone), a new `/api/agent` WebSocket lets the server reach back into the desktop's own real `interopApi.callMethod` for capabilities it structurally can't have itself (VR overlay, Discord RPC, log tailing, registry), and `client-desktop/**` gives it the same RPC-backed `database`/`config`/`webapi` treatment phase 4 gave the browser client — server-verified (build output, 85/85 tests) but **still wants a live desktop pass**, the same bar phase 4 closed with Chrome. `serve`'s auth was then replaced outright — a rotating TOTP code instead of the static password phase 3 shipped with, requested mid-session — with both clients driving first-run enrollment themselves (a real QR code, `qrcode-generator`) rather than requiring the CLI; one-shot by design, so the secret/QR can never be shown again in a browser once confirmed, only rotated via `setup-totp`. **Phase 6 (hardening) is done** (§8): `serve`/`pipeline` now hold an exclusive PID lockfile next to `VRCX.sqlite3` so two of this fork's own long-running processes can't open it at once (verified live: a second `serve` refuses with a clear pid-bearing error, `migrate` refuses against a locked database unless `--force`, a clean shutdown releases the lock); an audit of all 86 un-awaited `database.*`/`configRepository.*` write call sites found zero correctness bugs (upstream's own fire-and-forget design, not a fork gap) but one real one — failures were silent on the RPC-backed clients — closed with a single `unhandledrejection` → `vue-sonner` toast listener, verified live by triggering a real rejection in the browser; and the Electron desktop client's build process, previously undocumented outside a stale upstream-only CI workflow, is now written up in `client-desktop/README.md`. Sections below covering finished, working machinery are collapsed (`<details>`) so this file reads as "what's left" first — expand them when you need the how-it-works reference, not to re-verify what's already proven.

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
                    │  • HTTP RPC + WS fan-out, password auth   │
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
| `client-web/**` | ours | Browser-client shims (phase 4). |
| `client-desktop/**` | ours | Desktop-agent shims + server-connection gate (phase 5). |
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

<details>
<summary><strong>§3 — how it works (done, phase 0–2a; expand for the mechanism reference)</strong></summary>

## 3. How the server runs upstream code unmodified

The server imports VRCX's *real* data layer. Nothing is copied or vendored. Three mechanisms make that work:

### 3.1 Module resolution (`server/hooks.mjs`)

A Node ESM `resolve` hook, registered by `server/register-hooks.mjs`, does two things:

- **Emulates Vite's resolver.** `src/**` uses extensionless and directory imports (`import { dbVars } from '../database'`) that plain Node rejects. The hook tries the exact path, then `.js`/`.mjs`/`.json`, then `index.js`.
- **Applies two alias maps**, both declared in `server/aliases.js`:
  - `aliases` — keyed by *resolved absolute path*, so it does not matter whether a module writes `../stores`, `../../stores/index.js`, or anything else. Deliberately more robust than Vite's specifier-based aliases.
  - `packageAliases` — keyed by *bare npm specifier*, for packages that cannot run under Node at all. Matched before path resolution, since there is no path to resolve.

It also forces `format: 'module'` for files under `src/`, because the root `package.json` has no `"type": "module"` and Node would otherwise parse them as CommonJS.

Vitest has its own module pipeline and never sees the Node hook, so `server/vite-alias-plugin.js` re-implements the same logic as a Vite plugin. **Both read `server/aliases.js`**, so the two paths cannot drift.

### 3.2 Compile-time globals (`server/src/globals.js`)

Vite's `define` block (`src/vite.config.js`) replaces `LINUX`, `WINDOWS`, `VERSION`, `NIGHTLY` at build time. Under Node they are installed as real globals, plus `window = globalThis` so module-scope assignments like `window.database = database` work.

Both platform flags are **false** on the server: it is neither the CEF/Windows build nor the Electron/Linux build. `src/services/sqlite.js` branches only on `LINUX`, so this selects the plain `SQLite.Execute` path — and, in `src/services/webapi.js`, the `WebApi.Execute` tuple path.

It also installs a **`CloseEvent` polyfill**. Node has `WebSocket` but not `CloseEvent`, and `src/services/websocket.js:118` handles `socket.onerror` by constructing one and calling its own `onclose` — which is what schedules the reconnect. Without the polyfill a network blip throws inside the error handler and the pipeline never reconnects. See §3.6 for the rest of that family.

### 3.3 The SQLite shim (`server/src/shims/sqlite.js`)

A behavioural port of `Dotnet/SQLite.cs` onto `node:sqlite`. Three fidelity requirements, each load-bearing and each covered by a test in `server/test/sqlite-shim.test.js`:

| Requirement | Why | Mechanism |
|---|---|---|
| Rows are **positional arrays** | Every caller indexes `row[0]`, `row[1]` and depends on `SELECT` column order; object rows would also collapse duplicate column names in joins | `statement.setReturnArrays(true)` |
| **Unknown named parameters are ignored** | System.Data.SQLite accepts parameters the statement never references; `node:sqlite` throws | `statement.setAllowUnknownNamedParameters(true)` |
| **Error text is SQLite's own** | `handleSQLiteError` in `src/services/sqlite.js` string-matches `database disk image is malformed`, `database or disk is full`, `database is locked`, `disk I/O error` | no wrapping of driver errors |

Plus parameter coercion: `node:sqlite` binds only null/number/bigint/string/Uint8Array, while the data layer passes `undefined` for absent VRChat API fields and booleans for flags. `coerceParameter()` maps `undefined`→null, `boolean`→0/1, `Date`→`toJSON()`, and throws on anything else (an object here is a call-site bug, and System.Data.SQLite would reject it too).

Connection PRAGMAs mirror the connection string at `Dotnet/SQLite.cs:37`: `locking_mode=NORMAL`, `busy_timeout=5000`, `journal_mode=WAL`.

### 3.4 Database location (`server/src/paths.js`)

Same resolution order as the desktop app, so the server points at an existing install's file:

1. `VRCX_DATABASE` env var (server-only escape hatch)
2. `VRCX_DatabaseLocation` in `VRCX.json` (`Dotnet/SQLite.cs:33`)
3. `<appdata>/VRCX/VRCX.sqlite3` (`Dotnet/Program.cs:33`) — `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` (default `~/.config`) elsewhere, matching .NET's `SpecialFolder.ApplicationData`

### 3.5 The WebApi shim (`server/src/shims/webapi.js`)

A behavioural port of `Dotnet/WebApi.cs` onto Node's global `fetch`. `src/services/webapi.js` is the only consumer, unmodified. Non-obvious contract points, each covered by a test in `server/test/webapi-shim.test.js`:

| Requirement | Why |
|---|---|
| `Execute` returns `{Item1, Item2}` and **never throws** | `src/services/webapi.js:37` reads the tuple; transport failures are `Item1 === -1` with the message in `Item2` |
| On failure the value thrown upward must be a **string** | `webapi.js:39` does `throw item.Item2`, and `$throw` (`request.js:346`) does `typeof error === 'string' ? error : JSON.stringify(error)` — an `Error` stringifies to `{}` and the cause is lost |
| Binary responses return `` `data:image/png;base64,…` `` | `WebApi.cs:468` hardcodes the `image/png` prefix regardless of the real content type; callers depend on that exact shape |
| `Content-Type` goes on the body, `Referer` is a real referrer | `WebApi.cs:445` |
| User-Agent is `VRCX <version>` / `VRCX Nightly <version>` | `Program.cs:67`; VRChat rate-limits generic agents, so this is functional |
| Redirects are followed **by hand** | so the cookie jar is applied on every hop, as `CookieContainer` does natively |

Uploads (`uploadImage`, `uploadImageLegacy`, `uploadImagePrint`, `uploadFilePUT`) return a clear "not supported" error rather than a wrong body. No server-side call site reaches them yet.

Proxy support is `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` (set in the container), replacing `WebApi.cs:99-131` without taking an `undici` dependency.

### 3.6 Cookies (`server/src/cookies.js`)

`tough-cookie` for the jar, but persisted in **`Dotnet/WebApi.cs`'s exact format** so the same `VRCX.sqlite3` stays readable by the desktop app: base64 of a JSON array of `System.Net.Cookie` objects with PascalCase keys, one row in `cookies` keyed `'default'`.

Two details that are easy to miss and break logins if dropped:

- The `cookies` table is created by the **C# side**, not by the JS migration layer, so the shim creates it too.
- `GetAllCookies()` (`WebApi.cs:204`) forces every expiry to `DateTime.MaxValue` (`9999-12-31T23:59:59.9999999`) so session cookies survive a restart. Reproduced deliberately.

Nothing in `src/**` parses the blob — `src/stores/auth.js` only moves it between `WebApi.GetCookies()` and `savedCredentials` — so the format is ours to choose. We chose .NET's on purpose, for interoperability during the transition.

### 3.7 Node's missing — or browser-different — globals

Verified against the running Node, not assumed. `fetch`, `WebSocket`, `crypto.subtle` and `Blob` exist as globals, but not all of them behave like their browser counterparts. Missing entirely:

| Missing | Where it bites | Handling |
|---|---|---|
| `CloseEvent` | `src/services/websocket.js:118` — reconnect dies silently | polyfilled in `server/src/globals.js` |
| `Worker` | `worker-timers` builds its timer from a blob-URL Worker; **fails on first call, not on import** | `packageAliases` → `server/src/shims/worker-timers.js` |
| `navigator.onLine` | `src/coordinators/authAutoLoginCoordinator.js:14` reads it → falsy → "you're offline" forever | inject `() => true` (the function already takes it as a parameter) |
| `speechSynthesis` | `src/stores/settings/notifications.js` TTS | polyfilled in `server/src/globals.js` (`getVoices`/`cancel`/`speak`); stays a stub even after phase 5's agent channel, which is request/response, not a fit for routing an ongoing audio stream — see §9's "speechSynthesis is still a stub" entry |
| `AppApi` | ~81 methods across `Dotnet/AppApi/**`, called as a bare global throughout `src/**` | a `Proxy` in `server/src/globals.js` (`installAppApiPolyfill`) — no fixed method list to enumerate, so it answers arbitrary names with a logged no-op; `GetVersion()` is the one override, returning the real `VERSION` global |
| `VRCXStorage` | `VRCX.json` — explicitly desktop-owned (§1's ownership table), but `src/stores/{vrcx,friend}.js`, `settings/general.js` and two coordinators reference the bare global regardless | in-memory, process-lifetime `Map`-backed stub in `server/src/globals.js` (`installVrcxStoragePolyfill`) |
| `document` | A bounded set of stores touch it directly (not through the `appActions.js`/`base-ui.js` aliases): `documentElement.classList`, `getElementById`, `querySelector(All)`, `createElement` | polyfilled in `server/src/globals.js` (`installDocumentPolyfill`) — `createElement` exists only because `@vue/runtime-dom` feature-checks it at module scope the moment anything imports `'vue'` |

Present, but behaving differently — **found in this fork's first live-VRChat test** (2026-08-14, real account, real network, outside CI), not by inspection:

| Present but different | Where it bites | Handling |
|---|---|---|
| `WebSocket` sends no default `User-Agent` | Cloudflare in front of `pipeline.vrchat.cloud` drops the handshake silently without one (confirmed by hand-rolling the HTTP upgrade over raw TLS: succeeds with the header, never reaches `onopen` without it), surfacing only as an immediate `onerror` + 1006 close and an endless 5 s reconnect loop | Phase 2a: fixed locally, in the now-deleted `server/src/vrchat.js` scaffold's own `new WebSocket()` call. Phase 2b step 7: `src/services/websocket.js:82` makes the identical bare call and hit the identical wall — a browser sends its own User-Agent automatically, so upstream never had to think about this, and invariant 1 forbids editing that call site. Fixed for good with a global `WebSocket` wrap instead (`installWebSocketUserAgentPolyfill`, `server/src/globals.js`), which only patches the zero-options call shape. |
| `window` is `globalThis` | Makes `typeof window !== 'undefined'` true everywhere, defeating `@tanstack/query-core`/`@vueuse/core`'s SSR guards | Phase 2b step 6 (§8) — a `Proxy` whose `set` trap mirrors writes onto `globalThis`, so bare-identifier reads of the properties `src/**` assigns through `window.X = Y` (`$debug`, `database`, `webApiService`, …) still work without `window` being a literal alias |

### 3.8 Schema version

`server/src/db.js` **reads the target version out of `src/stores/vrcx.js`** with a regex rather than duplicating the constant, so an upstream bump is picked up automatically instead of silently skipping migrations. If the regex stops matching, it logs a warning and falls back to 16 — treat that warning as a merge task.

</details>

---

## 4. Seam table

The modules where the split happens. On an upstream merge, these are what to inspect.

| Seam | Upstream file | Width | Server side | Web client (phase 4, done) | Desktop client (phase 5, done) |
|---|---|---|---|---|---|
| SQL transport | `src/services/sqlite.js` | 2 methods; the **only** `window.SQLite` caller | real `node:sqlite` via `server/src/shims/sqlite.js` | unused — never bundled, once the two rows below are aliased away (verified: no `SQLite.Execute`/`handleSQLiteError` in the built client) | same — unused, verified in `npm run prod-linux`'s output too |
| DB repository | `src/services/database/index.js` | flat ~190-method facade, 206 call sites | imported unmodified | `Proxy` → `rpc('db', name, args)`, `client-web/shims/database.js` | same shape over IPC instead of `fetch`, `client-desktop/shims/database.js` |
| Config KV | `src/services/config.js` | 13 methods, ~540 call sites | imported unmodified | RPC + write-through cache, `client-web/shims/config.js` | same, `client-desktop/shims/config.js` |
| VRChat HTTP | `src/services/webapi.js` | 4 methods; the **only** `window.WebApi` caller | `fetch` + tough-cookie via `server/src/shims/webapi.js` | proxied via server (`rpc.js`'s `webapi` target), `client-web/shims/webapi-target.js` | same target, `client-desktop/shims/webapi-target.js` |
| Pipeline WS | `src/services/websocket.js` | `handlePipeline` switch | runs unmodified (phase 2b step 7) | subscribes to server stream via an `AppDebug.websocketDomain` override (`client-web/bootstrap.js`), calls the same `handlePipeline` unmodified | not touched — the desktop renderer still connects straight to VRChat's real pipeline via `websocket.js`'s own unmodified path; only the *DB/config/webapi* seams moved server-side |
| Daemon | `src/stores/updateLoop.js` | 1 Hz counter loop | runs here, and only here | no-op store, `client-web/shims/update-loop.js` | same, `client-desktop/shims/update-loop.js` |
| Native globals | `src/plugins/interopApi.js` | 42 lines; the **only** injection point | n/a | third `WEB` branch, installs `client-web/shims/{webapi-target,app-api,vrcx-storage}.js` | existing Electron branch, in place: `WebApi` swapped for the RPC target, `SQLite` no longer installed, `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager` stay the real `InteropApi.*` objects |
| Native capabilities → server | `Dotnet/AppApi/**`, `LogWatcher.cs`, `Discord.cs`, `AssetBundleManager.cs` | ~93 methods across 4 globals, all desktop-only | agent-aware `Proxy` polyfills (`server/src/globals.js`) — forward to a connected agent, else no-op | n/a — the browser has none of these capabilities at all | `server/src/agent.js` ↔ `/api/agent` WS ↔ the same `interopApi.callMethod` the renderer's own native calls already use |

### Current alias map (`server/aliases.js`)

`src/stores/index.js` (the barrel) is **not** aliased — phase 2b step 4 imports it for real. Everything below is the specific pieces of its closure that can't run under Node; `server/aliases.js`'s own comments are the source of truth if this table and the code ever disagree.

| Aliased upstream module | Replaced by | Why | Permanent? |
|---|---|---|---|
| `src/plugins/i18n.js` | `server/src/shims/i18n.js` | Builds a vue-i18n instance and eagerly imports every locale bundle; the data layer only calls `i18n.global.t` (plus `loadLocalizedStrings` et al., now stubbed too). | yes |
| `src/plugins/index.js` | `server/src/shims/plugins-index.js` | Re-exports `./components` (raw `.vue` imports, unparseable under Node) and `./router` — one of the two 629-file closure edges. | yes |
| `src/plugins/router.js` | `server/src/shims/router.js` | Imports every view directly to build its route table — the other closure edge. | yes |
| `src/stores/ui.js` | `server/src/shims/ui.js` | Dialog bookkeeping only (`document.body.addEventListener`, `useMagicKeys()`). | **yes — a headless process has no dialogs** |
| `src/stores/modal.js` | `server/src/shims/modal.js` | `confirm`/`alert`/`prompt` resolve when a human clicks a dialog button. `otpPrompt` is the one exception: reads a real 2FA code from stdin (phase 2b step 7). | **yes**, `otpPrompt` aside |
| `src/workers/activityWorkerRunner.js` | `server/src/shims/activity-worker-runner.js` | Its only content is a Vite-only `?worker&inline` import. Every message type it dispatches is a pure function from `activityEngine.js`, run in-process instead. | yes (Vite syntax) |
| `src/stores/quickSearchWorker.js` | `server/src/shims/quick-search-worker.js` | Same Vite-only problem, but this worker's search index is stateful with zero imports — loads the real file's source via a `data:` URL instead of reimplementing it. | yes (Vite syntax) |
| `src/localization/index.js` | `server/src/shims/localization.js` | Two module-scope `import.meta.glob(...)` calls. `languageCodes` (the only thing reached) is re-exported for real from the Vite-free `./locales.js`. | yes (Vite syntax) |
| `src/shared/utils/appActions.js` | `server/src/shims/app-actions.js` | UI actions (confirm dialog, clipboard, `<a download>`, bare `AppApi.*` calls), reached via `common.js`'s backward-compat re-export. The other ~31 files in the `shared/utils` barrel are real, unaliased business logic. | yes |
| `src/shared/utils/base/ui.js` | `server/src/shims/base-ui.js` | Theme/font/CSS DOM mutation. `HueToHex`/`HSVtoRGB`/`getThemeMode` are reimplemented for real (pure math + a real `configRepository` read); everything else is a no-op. | yes |
| `worker-timers` *(package)* | `server/src/shims/worker-timers.js` | Schedules through a blob-URL Web Worker; `Worker` does not exist in Node, and it fails on first call rather than at import. Node has no timer throttling to dodge — plain timers are correct. | yes |
| `vue-sonner` *(package)* | `server/src/shims/toast.js` | Every API error in `request.js`/`websocket.js`/13 coordinators is a toast. Headless, structured log lines — `/api/stream` (phase 3) only relays raw pipeline frames so far, not toasts; making those a stream event too is unclaimed follow-up work, not something phase 3 turned out to need. | yes |
| `noty` *(package)* | `server/src/shims/noty.js` | Login/logout greeting via `new Noty(...).show()`. Unlike `vue-sonner`, runs `document.addEventListener` at module load — can't be deferred to call time, has to be a package alias. | yes |

### The store-graph problem (measured, not estimated)

Importing *any* background store today pulls a **629-file closure including ~300 `src/components/**` and ~144 `src/views/**`**, through exactly two edges:

- `src/stores/settings/appearance.js:29` → `src/plugins/index.js` (a barrel re-exporting `./components` and `./router`)
- `src/stores/avatarProvider.js:4` → `src/plugins/router.js`

Aliasing those two drops it to **148 files and 11 npm packages**. That is why phase 2 was split: 2a avoids the store layer entirely, 2b takes it on. Full recipe in §8.

One benign-looking edge to leave alone: `src/stores/gameLog/index.js:5` imports `src/views/GameLog/sessions/buildGameLogSessions.js`, which is a pure function that merely lives under `views/`. Do not add a path-prefix rule that rejects it — and note `.dockerignore` keeps `src/**` whole for this reason.

---

## 5. Patch inventory

Every modification to an upstream-owned file. Keep this exhaustive and keep it short.

<details>
<summary>Full table (9 entries)</summary>

| File | Change | Why not an alias | Anchor |
|---|---|---|---|
| `package.json` | `name`, `description`, `homepage`, `bugs`, `repository` retargeted at the fork; added `test:server` and `server` scripts; added `tough-cookie` to `devDependencies`; phase 4 added `dev-web`/`prod-web` scripts and `ws`; phase 5 added `client-desktop/setup.html`/`setup.js` to the electron-builder `build.files` allowlist; the TOTP work added `qrcode-generator` to `dependencies` (client-side QR rendering) plus its one needed file, `node_modules/qrcode-generator/dist/qrcode.js`, to `build.files` (the desktop setup page loads it as a plain classic `<script>`, not a bundled import — see the TOTP section) | Package identity and scripts cannot be aliased. `tough-cookie`/`ws` are declared so local dev does not depend on them being hoisted as somebody else's transitive dep — both are also real dependencies in `server/package.json`, and `server/scripts/check-deps.js` enforces the two match. The `build.files` entries exist because only `build/html/**` (the Vite-compiled output) normally ships in a packaged build — everything loaded standalone/unbundled needs to be listed explicitly or a packaged app can't find it | top-of-file metadata block; `scripts` after `"test:coverage"`; `dependencies`; `devDependencies` after `"tailwindcss"`; `build.files` array |
| `.github/workflows/ci.yaml` | Re-enabled the `pull_request` trigger (upstream ships it commented out) and added `push` on `main` | CI config cannot be aliased | `on:` block at the top |
| `.gitignore` | Added `!CLAUDE.md` — upstream ignores AI guidance files, but this one is the fork's maintenance guide and must be tracked | Ignore rules cannot be aliased | after the `AGENTS.md` / `AI_GUIDE.md` / `CLAUDE.md` lines |
| `README.md` | Added a short "About this fork" block pointing at `server/README.md` and this file | Docs cannot be aliased. Kept to a pointer on purpose: the real server documentation lives in `server/README.md`, which is ours and carries no merge surface | immediately before `# Getting Started` |
| `src/plugins/interopApi.js` | Phase 4: added a third `else if (WEB)` branch beside the existing `WINDOWS`/Electron branches, installing `client-web/shims/{webapi-target,app-api,vrcx-storage,log-watcher}.js` (the last one added during the live-browser pass — see §8's phase 4 write-up). Phase 5: the existing Electron `else` branch itself now swaps `window.WebApi` for `client-desktop/shims/webapi-target.js` and stops installing `window.SQLite`; `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager`/`AppApiVrElectron` are untouched, still the real `InteropApi.*` objects. Phase 6: both the `WEB` and Electron branches now also call a new `installUnhandledRejectionReporting()` (defined in this same file) — a `window.addEventListener('unhandledrejection', ...)` reporting failed RPC writes via the existing `vue-sonner` toast convention; deliberately not called from the `WINDOWS`/CefSharp branch, which has no RPC hop to swallow a rejection in the first place. Post-phase-6: this listener now skips toasting when `event.reason.alreadyToasted` is set, so it doesn't double up with `client-web/shims/app-api.js`'s own toast-then-throw (see §9's "throws for everything else" entry) for the one failure mode both can see | This *is* the seam table's designated native-globals injection point — the whole reason it exists is to be the one place a new platform branch goes | the `if (WINDOWS) {...} else {...}` block inside `initInteropApi`; `installUnhandledRejectionReporting` above it |
| `src/vite.config.js` | Phase 4: added `WEB` to the `define` block, a platform-conditional `resolve.alias` (via `server/vite-alias-plugin.js`, reused), a separate `outDir`, and a dev-mode port/proxy branch. Phase 5: reused the same plugin a third time for `PLATFORM === 'linux'` (`client-desktop/aliases.js`). Found live afterward: pinned `publicDir` to the real `src/public` explicitly — Vite defaults it to `<root>/public`, and `client-web/`'s root has no `public/` of its own, so every asset under `src/public/**` (icons, masks, fonts referenced by absolute path) was silently missing from the web build, `copyPublicDir: true` notwithstanding | Build config cannot be aliased — this file *is* the alias mechanism for everything else | `define` block; `plugins` array; `server`/`build.outDir`/`build.rolldownOptions.input`; `publicDir` |
| `src-electron/main.js` | Phase 5: removed the `SQLite`/`WebApi` .NET object `Init()` calls entirely; added a `vrcx-connect-server` IPC handler (logs into a remote server, opens the `/api/agent` WebSocket, answers forwarded calls with the real `interopApi.callMethod`), a `vrcx-rpc` handler relaying `database`/`config`/`webapi` calls, and a startup gate probing the stored session before loading the real app vs. a new `client-desktop/setup.html`. TOTP work: two more handlers, `vrcx-totp-setup`/`vrcx-totp-confirm`, mirroring `server/src/http-server.js`'s own two routes | This is `main.js`'s own boot sequence and IPC surface — nothing to alias, the whole point is *changing* what this file does at startup | the `interopApi.getDotNetObject(...)` block near the top; `ipcMain.handle('vrcx-connect-server'/'vrcx-rpc'/'vrcx-totp-setup'/'vrcx-totp-confirm', ...)` calls beside the existing `callDotNetMethod` one; `createWindow()`'s `mainWindow.loadFile(...)` call |
| `src-electron/preload.js` | Phase 5: added a `vrcxDesktopAgent` `contextBridge.exposeInMainWorld` (`connectToServer`, `rpc`), beside the existing `interopApi` one. TOTP work: two more bridged calls, `checkTotpSetupNeeded`/`confirmTotpSetup` | Same reasoning as `interopApi`'s own bridge just above it in this file — a new IPC surface needs a new bridge entry, there's nothing to alias | beside the existing `contextBridge.exposeInMainWorld('interopApi', ...)` call |
| `src/styles/globals.css` | Phase 4 live-browser pass: one `@source '..';` line right after `@import 'tailwindcss';` | Tailwind v4's automatic content detection scans relative to Vite's configured root; `client-web/`'s root is a *sibling* of `src/`, not an ancestor, so classes used only deep in `src/**` (found live: `sr-only`, which left several controls rendering as raw unstyled text) never made it into the web build's stylesheet. `@source` is v4's own documented escape hatch for exactly this "CSS file in a different location than its content" shape, and it only works from inside the same `@import` chain as `@import 'tailwindcss'` itself — a separate CSS file pulled in via a plain JS `import` (tried first) doesn't register, confirmed empirically. A complete no-op for the desktop build, which already scans this tree by default from its own root | immediately after `@import 'tailwindcss';` |

`src/App.vue` did **not** need an edit, contrary to what this table's previous entry anticipated — tracing the real boot sequence (`src/app.js`) found no hook to gate on inside it; the server-login gate lives entirely in `client-web/**` instead (see §8's phase 4 write-up). `Dotnet/**` remains fully unmodified — phase 5 changes what `src-electron/main.js` *calls* (removing the `SQLite`/`WebApi` `Init()` calls), not the C# itself. Nothing else under `src/`, `Dotnet/`, or `src-electron/` has been modified.

</details>

### Temporary scaffolds (not patches, but debts) — this is the live phase 2b target

| Where | What | Removed by |
|---|---|---|
| `server/src/vrchat.js` | Drives the 4 auth endpoints and the pipeline connection directly instead of through `src/services/request.js` / `src/services/websocket.js`, because both drag in the 629-file store closure | phase 2b, which switches to `src/api/auth.js` and the real websocket module |

Do not grow that file. Anything added to it is divergence phase 2b has to unpick.

---

## 6. Upstream sync procedure

Upstream's default branch is **`master`**; ours is **`main`**. The `upstream` remote is `https://github.com/vrcx-team/VRCX.git`.

**Sync to upstream's latest tagged release, never to `master` HEAD.** Upstream tags releases `vYYYY.MM.DD` (current latest: `v2026.07.18`, matching the repo-root `Version` file) roughly every few weeks; `master` moves under an active, UI-heavy project between them. Merging HEAD pulls in whatever landed since the last tag, sight unseen, and turns every sync into a moving target instead of a discrete, reviewable step tied to a version this fork can actually claim to track.

```bash
git fetch upstream --tags
git checkout -b sync/<tag> main
git merge v2026.07.18   # the tag being synced to, not upstream/master
```

Pick the tag deliberately — check `git tag -l 'v*' | sort | tail -5` (or the [releases page](https://github.com/vrcx-team/VRCX/releases)) rather than always grabbing the newest one, in case a specific tag is what's actually being targeted for this sync.

### 6.1 Expected conflicts, ranked

1. `package.json` — dependency bumps land next to our identity/scripts changes. Keep both sides; take upstream's dependency block wholesale.
2. `.github/workflows/ci.yaml` — take upstream's job definitions, keep our `on:` block.
3. *(from phase 4)* `src/plugins/interopApi.js`, `src/vite.config.js` — see §5's patch inventory.

Files under `src/services/database/**` and `src/services/config.js` should merge **cleanly** — we do not modify them. A conflict there means someone broke invariant 1.

### 6.2 Change-detection checklist

These break the split *without* producing a merge conflict. Check every one.

- [ ] **Schema version bumped?** `grep -n 'const databaseVersion' src/stores/vrcx.js`. The server reads this automatically, but new migrations must be re-run against the live DB.
- [ ] **New or renamed `database.*` methods?** `git diff main..upstream/master -- src/services/database/`. New methods work automatically (the client Proxy is name-based); **renames break call sites**, and new DDL needs a migration run.
- [ ] **`initUserTables` prefixing changed?** The per-user table prefix (`userId` with `-`/`_` stripped, leading digit prefixed with `_`) is assumed by the server and asserted in `server/test/db.test.js`.
- [ ] **`configRepository` signatures changed?** Any change breaks the client's cached shim (invariant 4).
- [ ] **`window.SQLite` contract changed?** `git diff main..upstream/master -- Dotnet/SQLite.cs src/services/sqlite.js`. New methods or changed row shapes must be mirrored in `server/src/shims/sqlite.js`.
- [ ] **Vite `define` block changed?** New compile-time globals must be added to `server/src/globals.js` *and* `server/vitest.config.js`.
- [ ] **New browser-only imports in the data layer?** `grep -rn "^import" src/services/database/ src/services/config.js src/services/sqlite.js` — anything beyond `../sqlite.js`, `../database`, and the three aliased modules needs a decision: new alias, or fix the specific module.
- [ ] **New `window.AppApi` methods used from stores/views?** They need a `capabilities` entry or the web client throws at runtime.
- [ ] **New `worker-timers` / `speechSynthesis` / `window.crypto` usage** in modules the server imports.
- [ ] **`handlePipeline` gained event types?** New cases must be forwarded on the client stream.
- [ ] **`Dotnet/WebApi.cs` changed?** `git diff main..upstream/master -- Dotnet/WebApi.cs src/services/webapi.js`. The cookie blob format, the `data:image/png;base64,` prefix, the header rules and the `-1` sentinel are all mirrored in `server/src/shims/webapi.js` and `server/src/cookies.js`.
- [ ] **New `src/plugins/index.js` or `src/plugins/router.js` importers** in stores/coordinators? Those two aliases are what keep the component/view tree out of the server; a new edge around them re-inflates the closure.
- [ ] **New npm dependency in the server's closure?** It must be added to `server/package.json` *and* the root, or the container will fail at runtime while dev works. `node server/scripts/check-deps.js` catches the mismatch half of this.
- [ ] **New browser global used at module or store-setup scope?** Those fail at import time in Node, not at call time. See §3.7.

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
npm run test:server
```

`login` → `whoami` → `pipeline` verified end-to-end against a real account on 2026-08-14, outside CI (see the status note at the top of this file).

Environment: `VRCX_DATABASE`, `VRCX_DATA_DIR`, `VRCX_LOG_LEVEL` (`debug|info|warn|error`), `VRCHAT_PASSWORD` / `VRCHAT_2FA_CODE` for non-interactive login.

`--user` is only needed to create per-user tables for an account the database has never seen; `login` does it automatically, and migrations for existing accounts discover their tables through `sqlite_schema` queries.

**Credentials are stored the way upstream stores them.** With no primary password set, `savedCredentials` holds the password in plaintext — that is upstream VRCX behaviour (`src/stores/auth.js:919-930`), not something this fork introduced. Do not silently "fix" it here; it would desync the desktop app. Treat `VRCX.sqlite3` as a secret.

---

## 8. Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Fork hygiene: upstream remote, unshallow, identity, CI on PRs | **done** |
| 1 | Server skeleton: SQLite shim, alias/loader layer, migrations, CLI, tests | **done** |
| 2a | Server owns the VRChat connection: WebApi shim, cookie jar, login/2FA CLI, pipeline connection. Multi-arch container + GHCR publishing | **done** |
| 2b | Pinia-in-Node: the background stores and the `updateLoop` daemon | **done** |
| 3 | Transport: password auth → session cookie, generic `/api/rpc` dispatcher, `/api/stream` WebSocket fan-out | **done** |
| 4 | Web client: `PLATFORM=web`, `client-web/shims/**`, `capabilities` gating | **done** |
| 5 | Desktop client as native agent: log forwarding up, overlay/Discord/notification commands down; .NET stops touching SQLite | **implemented, wants a live desktop pass** |
| 6 | Hardening: single-writer lock, awaited client writes, packaging | **done** |

### Phase 2b recipe — done (2026-08-14)

All 9 steps shipped; the background stores and the `updateLoop` daemon now run for real, headless, driven by the same code the desktop client uses. Kept in order below, since each step was independently verified against the previous one's failure boundary, but collapsed — this is what's already working, not what's next. Phase 5, in the roadmap table above, is what's next.

<details>
<summary><strong>Steps 1–9</strong> (expand for what actually shipped vs. what was originally planned)</summary>

Step 9 shipped out of order — eager instantiation in step 5 reached `AppApi` immediately rather than on first real use, so it stopped being optional before step 8 did.

1. ~~Alias the two component/view edges~~ **Done as planned.** `src/plugins/index.js` (exports `loadLocalizedStrings` plus the i18n re-exports, plus `getSentry`/`isSentryOptedIn` once step 4 needed them too) and `src/plugins/router.js` (a `router` with `currentRoute` as a ref and a `push()`). 629 files → 148.
2. ~~Alias `src/stores/activity.js`~~ **Aliased `src/workers/activityWorkerRunner.js` instead** — smaller, per invariant 3. Its only content is the Vite-only `./activityWorker.js?worker&inline` import, which fails at *resolve* time and can't be deferred; every message type it dispatches is a pure function from `activityEngine.js`, so the shim runs the same dispatch in-process and the real `useActivityStore` (DB-backed caching included) stays live rather than being stubbed away.
3. ~~Alias `src/stores/ui.js`~~ **Done as planned.** Dialog bookkeeping only (`document.body.addEventListener`, `useMagicKeys()`); stubbed forever, same as `modal.js` below.
4. ~~Replace the `src/stores/index.js` stub with a real barrel minus the UI stores~~ **Done, more surgically than "minus the UI stores" implied.** The barrel itself is real and unaliased now; only the specific pieces that can't run under Node are — `src/stores/modal.js` (dialogs, same reasoning as `ui.js`, split out of the old combined stub into its own file), `src/localization/index.js` (`import.meta.glob`; the real, Vite-free `locales.js` is re-exported for real), `src/shared/utils/appActions.js` (UI actions reached through `common.js`'s re-export — the other ~31 files in that barrel are real, browser-independent business logic and are no longer aliased away at all), and the `noty` package (runs `document.addEventListener` at module load, so — unlike `vue-sonner` — it needed a package alias, not just a deferred-call shim). Also fixed a real bug in `server/hooks.mjs` found along the way: `path.resolve` treats `?` as a literal filename character, so *any* specifier carrying a Vite suffix (`?worker&inline`, `?url`, `?raw`, …) never matched a real file and silently skipped both the alias map and `format: 'module'` forcing — not just for this step's `src/stores/quickSearchWorker.js` (loaded via a `data:` URL to dodge a self-referential alias deadlock; see that shim's own header), but for every such specifier, including future ones.

    `src/stores/index.js` imports cleanly with all 42 expected exports; `src/stores/auth.js` loads standalone.

5. ~~Mount a throwaway `createApp({})`~~ **Done, but the obvious version doesn't actually work — the real fix is a mounted component, not just `app.use(pinia)`.** `pinia._a.runWithContext` (what makes `inject()` — and so `useRouter()`/`useI18n()` — work outside a component) turns out not to be a re-entrant stack: nearly every store composes others before its own `useRouter()`/`useI18n()` call (`friend.js` calls `useGroupStore()` first; `charts.js` calls `useFriendStore()`, which itself calls `useRouter()`, first), and each nested `useXStore()`'s own `runWithContext` clears the injection context unconditionally on the way out instead of restoring the outer call's. Verified empirically: `useFriendStore()` alone instantiates fine, `useChartsStore()` throws "must be called at the top of a setup function". The real client never hits this because `App.vue`'s mounted `<script setup>` gives the whole `createGlobalStores()` call tree one stable `getCurrentInstance()` — `server/src/app.js` reproduces exactly that, using `@vue/runtime-core`'s `createRenderer` directly with inert no-op DOM ops rather than pulling in jsdom just to satisfy `@vue/runtime-dom`'s `window`/`SVGElement` checks for a component that never renders anything.

    Getting there this way (eager, once, for real) surfaced gaps the plan hadn't accounted for — each is a `server/src/globals.js` polyfill unless noted: `window.matchMedia` (`appearance.js` OS-theme listener at setup scope), `VRCXStorage` (explicitly desktop-owned per §1's ownership table, but five store/coordinator files reference the bare global directly regardless — in-memory, process-lifetime only), `AppApi.GetVersion()` needing a real value (see step 9), `speechSynthesis` (§3.7's existing entry, just needed sooner than expected), `document` (a bounded polyfill — `documentElement.classList`, `getElementById`, `querySelector(All)`, `createElement`; the last one exists only because `@vue/runtime-dom` does a module-scope `doc.createElement("template")` feature check the moment anything imports `'vue'`, harmless while `document` was `undefined` but not once this polyfill makes it truthy), and a new alias, `src/shared/utils/base/ui.js` → `server/src/shims/base-ui.js` (theme/font/CSS DOM mutation reached directly by `stores/{settings/appearance,vrcx}.js`; `HueToHex`/`HSVtoRGB`/`getThemeMode` reimplemented for real since re-exporting from the real file wasn't an option — same self-referential-alias problem as `quickSearchWorker.js`, but without that file's "zero imports" escape hatch for the `data:` URL trick).

**Step 9, `AppApi` stub — done**, out of order (see above): a `Proxy`, since there is no fixed method list to enumerate (every call site in `src/**` is a bare `AppApi.SomeMethod(...)`, spread across `Dotnet/AppApi/**`). Every reachable call site is fire-and-forget except `GetVersion()`, which returns the real `VERSION` global instead of the blanket no-op. Built server-only for now, not factored out for phase 4's client-side reuse yet — nothing to share but the idea until that phase exists.

`createGlobalStores()` returns all 39 stores with no errors, sync or async. 43/43 server tests and the CLI pass throughout.

6. ~~Narrow `window`~~ **Done, but "narrow the property list" (the original plan) turned out to be the wrong shape.** `window = globalThis` made `typeof window !== 'undefined'` true everywhere, defeating the SSR guards in `@tanstack/query-core`/`@vueuse/core` — nothing in the closure imports either yet, but that is exactly what an upstream merge adds unnoticed. A plain object with a fixed property list broke instead: in a real browser `window` *is* the global object, so `window.X = Y` (what `services/appConfig.js`, `services/database/index.js`, `services/config.js`, `services/sqlite.js`, `services/webapi.js`, `services/gameLog.js` and `api/index.js` all do at module load) also creates a bare top-level `X` — and `src/**` reads several of those as bare identifiers elsewhere, not only as `window.X`. Found live, not predicted: `stores/vrcxUpdater.js:304` reads bare `webApiService` and threw `ReferenceError` the moment `whoami` first exercised that path. Fixed with a `Proxy` instead — narrow reads (only `window.matchMedia`/`window.crypto` are seeded, both real reads found the same way), but every *write* through `window.X = Y` mirrors onto `globalThis[X]` too, matching real browser behaviour without re-opening the original SSR-guard hole (unrelated `globalThis` pollution still doesn't leak onto `window`).
7. ~~Delete the `server/src/vrchat.js` scaffold~~ **Done — `login`/`whoami`/`logout`/`pipeline` now drive `src/stores/auth.js`, `src/coordinators/userCoordinator.js` and `src/services/websocket.js` directly, verified live against a real account.** The real `login()`/`autoLoginAfterMounted()`/`handleCurrentUserUpdate()` all resolve as soon as the *first* request completes, 2FA pending or not — 2FA runs as an unawaited `.then()` chain off of it. `server/src/session.js`'s `waitForLogin` waits for `watchState.isLoggedIn` to actually flip instead, via a plain `watch()` outside any component (the process exits when the command is done, so nothing to dispose). Two dialog-gated exports needed a different approach than "just call them": 2FA is entirely `modalStore.otpPrompt()`-driven, so `server/src/shims/modal.js` gained a real stdin-backed implementation (there is no safe non-interactive default for a 2FA code, unlike a confirm dialog); `logout()` shows a confirm dialog first (which the modal stub always auto-declines — a silent no-op), so the CLI calls the also-exported `handleLogoutEvent()` directly instead, since running the `logout` command *is* the confirmation. `server/src/webapi-init.js` installs `window.WebApi` (the other half of the two-global contract alongside `window.SQLite`), factored out of the deleted scaffold's constructor since DB-only commands have no use for a session. Testing this live surfaced one more bug: `src/services/websocket.js:82` has the exact bare `new WebSocket(url)` call the "carried forward" note below predicted, hitting the same Cloudflare-drops-the-handshake-without-a-User-Agent wall the deleted scaffold already had to work around — fixed with a global `WebSocket` wrap (`installWebSocketUserAgentPolyfill`, `server/src/globals.js`).
8. ~~Run `src/stores/updateLoop.js` as the daemon~~ **Done — started once, unconditionally, from the `pipeline` command specifically**, not `mountHeadlessApp`/`bootstrapSession`: one-shot commands (`login`/`whoami`/`logout`) have no use for a recurring timer they'd tick once before the process exits anyway. Mirrors `App.vue`'s own `onBeforeMount` timing — the loop checks `watchState.isLoggedIn` internally every tick, so it doesn't need to be gated externally. The desktop-only counters (`LogWatcher.GetLogLines`, `AppApi.IsGameRunning`/`IsSteamVRRunning`) were already `if (LINUX ...)`-gated in the real loop itself — false on the server — so no extra work was needed to leave them inert, only for the loop to actually run and go find that out. Verified live: ~25 ticks with no errors, one real pipeline event received during the run.

</details>

**Login is `watch`-driven, which is why step 5 was unavoidable.** `loginComplete()` (`src/stores/auth.js:1011`) sets `watchState.isLoggedIn`; a watcher at `src/stores/friend.js:382` runs the friends init; that sets `isFriendsLoaded`; and a `{flush:'sync'}` watcher at `src/stores/auth.js:110` is what actually opens the pipeline WebSocket. `watchState` (`src/services/watchState.js`) is a plain `reactive()` object and is the system's clock — there is no imperative equivalent, so reactivity must be preserved rather than rewritten.

Other notes carried forward:

- `src/services/request.js` performs auth side effects inline on 401/403 (`handleAutoLogin`, the 2FA dialog, a VPN modal on 403 `config`). Aliasing gets it running; its error *reporting* becomes a stream event. Most likely source of real conflicts in future merges.
- It also holds an in-flight GET dedupe (10 s, keyed by URL) and a negative cache (15 min, keyed by endpoint, exported and mutable). Both become server-wide once it runs here — clear `failedGetRequests` on relogin.
- `src/services/security.js` uses `window.crypto.subtle`, which exists natively in Node; reuse as-is.
- Standardise the game-log delivery path on the queue/poll side (`LogWatcher.GetLogLines()`). The Windows path currently pushes via `ExecuteScriptAsync("window?.$pinia?.gameLog.addGameLogEvent", ...)`, a string coupling that cannot survive the split.

### Phase 3 — done (2026-08-14)

Unlike phase 2b, phase 3 had no pre-written recipe — the roadmap's one line ("password auth → session cookie, generic `/api/rpc` dispatcher, `/api/stream` WebSocket fan-out") was the whole spec. All server-owned, ours-to-maintain code, entirely under `server/**` — nothing in `src/**` needed a new alias for this phase.

**The password auth described below was replaced by TOTP** (see the "TOTP auth" section after phase 5) — kept here as the historical record of what phase 3 actually shipped; `scryptSync`/`hashPassword`/`set-password` no longer exist in the code.

<details>
<summary><strong>What shipped</strong> (expand for the design and why)</summary>

- **Password auth → session cookie** (`server/src/http-auth.js`): `scryptSync` + a random salt, timing-safe compare, no new dependency (`node:crypto` is built in). Password source, checked in order: `VRCX_SERVER_PASSWORD` env var (compared directly, timing-safe — non-interactive/Docker setup, same convention as the existing `VRCHAT_PASSWORD`), then a hash stored via the new `set-password` CLI command. Neither set → `serve` refuses to start rather than open an unauthenticated listener. Sessions are `crypto.randomBytes(32)` tokens in an in-memory `Map` — process-lifetime only, a deliberate scope cut for this first slice, not an oversight; restarting `serve` signs everyone out. Cookie is `HttpOnly`/`SameSite=Strict`; `Secure` is added automatically once TLS is in play (phase 4 added `--tls-cert`/`--tls-key`, see below) and stays off otherwise, since the common deployment is a home-network Docker container over plain HTTP and requiring TLS out of the box would just break that.
- **Generic `/api/rpc` dispatcher** (`server/src/rpc.js`): `database.*` and `configRepository.*` are both flat method-bag objects (the seam table above), which is what makes one generic dispatcher possible at all — `{ target: 'db' | 'config', method, args }` → `target[method](...args)`, no per-method wiring. No allowlist beyond a real safety hole found by a test, not guessed: `typeof targetObject[method] === 'function'` alone lets `constructor` straight through (`typeof Object === 'function'`), so the actual guard is `method in Object.prototype` — catches `constructor`, `__proto__`, `hasOwnProperty`, `toString`, etc. in one check, since no real method on either target is ever named one of those. Phase 4 added a third target, `webapi` → `globalThis.WebApi`, for the same reason and the same guard.
- **`/api/stream` WebSocket fan-out** (`server/src/pipeline-relay.js`): the pipeline connection (`src/services/websocket.js`) is the *only* reachable `new WebSocket()` call site in the whole server closure, so tapping the global `WebSocket` constructor sees every pipeline frame with no risk of catching unrelated traffic. `installPipelineRelayPolyfill` runs after `installWebSocketUserAgentPolyfill` (`server/src/globals.js`) and further subclasses the already-patched constructor, adding one `addEventListener('message', …)` per instance. Verified empirically before relying on it (not assumed): assigning `.onmessage` and calling `.addEventListener('message', …)` on the same `WebSocket` are independent — both fire, neither replaces the other — so `websocket.js`'s own handling (parsing, `handlePipeline`, reconnect-on-close) is completely undisturbed. The server relays frames verbatim, doing no interpretation of them — matching the seam table's phase-4 design: the *client* subscribes and calls the same `handlePipeline` itself, the same way the desktop app does.
- **HTTP server + `serve`/`set-password` CLI commands** (`server/src/http-server.js`): raw `node:http` (`node:https` too, once phase 4 added TLS) — three routes plus one WS upgrade doesn't justify a framework — plus the `ws` package (added to both `package.json`s, `server/scripts/check-deps.js`-checked) for the WebSocket *server* role specifically, since Node's built-in `WebSocket` only covers the client role already used for the pipeline connection. `serve` requires a VRChat session for the pipeline relay but not for `/api/rpc` — `db`/`config` access works without one, so a missing session is a logged warning, not a hard failure.

Verified live: `curl` round-trips for `/api/login` (wrong password → 401, correct → session cookie), `/api/rpc` against real `configRepository`/`database` data (rejects `constructor`, unauthenticated requests get 401), and the WS relay end-to-end with a synthetic frame injected directly into `pipelineRelay` (VRChat wasn't running during this pass to generate a real one, but the same tap mechanism the earlier `onmessage`/`addEventListener` coexistence check proved is what carries real frames too). 63/63 server tests pass (43 from before phase 3 + 20 new, for `http-auth.js` and `rpc.js`).

</details>

### Phase 4 — done (2026-08-14), verified live in a real browser

Decided up front with the user: **same-origin.** `serve` also serves the built web client as static files, so the browser only ever talks to its own origin — no CORS, no server-URL entry screen. Server-side design and mechanics below; the live-browser pass (real Chrome, real VRChat account, real `VRCX.sqlite3`) found five more real bugs on top of the two below, all fixed — see the second `<details>` block.

<details>
<summary><strong>What shipped</strong> (expand for the design, and two real bugs found building it)</summary>

- **Aliasing surface is much smaller than the server's.** Tracing every seam-table row against real call sites (not assumed) found that almost everything phase 2b/3 had to alias away for Node — `src/plugins/index.js`/`router.js`, `src/stores/ui.js`/`modal.js`, `import.meta.glob`, `?worker&inline`, the `worker-timers`/`vue-sonner`/`noty` packages — is either Vite-only syntax a real `vite build` handles natively, or a real browser capability (dialogs, Web Workers) the *server* never had, not something a *browser* lacks. A real browser running the real Vue app needs almost none of it. Only three seams survive: `src/services/database/index.js` and `src/services/config.js` (both bottom out in `src/services/sqlite.js`, which needs a native `window.SQLite` binding no browser has) → `client-web/shims/{database,config}.js`, `Proxy`/RPC-backed; and `src/stores/updateLoop.js` (the seam table already called this one: "no-op store" — the server's `serve` runs the one real daemon loop) → `client-web/shims/update-loop.js`.
- **`window.WebApi`/`AppApi`/`VRCXStorage`** (`client-web/shims/{webapi-target,app-api,vrcx-storage}.js`), installed by a new `WEB` branch in `src/plugins/interopApi.js` (the seam table's designated injection point, additive beside the existing `WINDOWS`/Electron branches — invariant 5). `WebApi.Execute` proxies the real VRChat call through `/api/rpc`'s new `webapi` target (`server/src/rpc.js`) rather than `fetch`ing `api.vrchat.cloud` directly — the browser has no VRChat cookie jar to use even if CORS allowed it (§1's ownership table), and this is also *why* CORS never becomes a question: the browser only ever talks to its own origin. `AppApi` is a `Proxy` that **throws** on anything not explicitly implemented — the opposite default from the server's silent-no-op polyfill, deliberately: a human is looking at the screen here, so a UI handler should be able to catch the throw and disable/hide the control, not pretend success. Only `GetVersion`/`SetUserAgent`/`GetClipboard` are implemented for real in this slice; the ~35+ desktop-only methods (VR overlay, Discord RPC, registry, `CopyImageToClipboard(path)` — a file path a browser has no access to) are explicit follow-up, not a gap to paper over. `VRCXStorage` is `localStorage`-backed, mirroring the server's in-memory polyfill method-for-method — §9's "Known limitations" already called this one as an explicit stub, not full parity.
- **No `src/App.vue` edit needed**, contrary to what CLAUDE.md's own §6.1 anticipated before this phase actually traced the boot sequence. `src/app.js` (the real, unmodified entry `index.html` loads) top-level-awaits `initPlugins()`/`initPiniaPlugins()` and creates the app the moment it's imported — there's no hook inside it to gate on. So the server-login gate lives entirely outside `src/**`: `client-web/index.html` + `client-web/bootstrap.js` render a plain password form, `POST /api/login`, and only `import('../src/app.js')` once a session cookie exists. `bootstrap.js` also sets `AppDebug.websocketDomain` (`src/services/appConfig.js`, already a plain mutable override knob upstream, not a hardcoded literal) to this origin's `/api/stream` before that import — so `src/services/websocket.js`'s unmodified `connectWebSocket()` connects to the server's relay instead of VRChat's real pipeline, with **no `WebSocket`-constructor interception needed**, unlike the server's own `installWebSocketUserAgentPolyfill`.
- **Two real bugs found building the alias plugin**, both in the *shared* `server/vite-alias-plugin.js` (reused rather than reimplemented — it already did resolved-path matching, parameterized by which map to apply): (1) `packageAliases` (`worker-timers`/`vue-sonner`/`noty` → server shims) was read from the module-level import unconditionally, not from the function's parameter — so the very first client build silently aliased `vue-sonner` to the server's headless toast stub, which doesn't export the real `Toaster` component, and failed with a `MISSING_EXPORT` error. Fixed by threading a second parameter through, defaulting to the server's own map so `server/vitest.config.js`'s existing no-args call is untouched; the client passes `{}`. (2) Even after that fix, the real `src/services/database/index.js` barrel (and transitively `sqlite.js`) still ended up in the bundle. Traced with a temporary debug log in the plugin's own `resolveId`: two real call sites (`src/views/Dashboard/widgets/GameLogWidget.vue`, `src/views/Charts/components/HotWorlds.vue`) import the database barrel as `@/services/database` rather than a relative path, and by the time the plugin's `resolveId` saw it, Rolldown's own native `resolve.alias` (`'@' → src/`) had *already* rewritten it to an absolute path — unlike classic Rollup, Rolldown doesn't wait for a `'pre'`-enforced JS plugin before applying its own alias config. Fixed by handling absolute-path specifiers directly in `resolveId`, verified by grepping the resulting bundle for `handleSQLiteError`/`SQLite.Execute`/config.js's `transformKey` marker — none present.
- **Build tooling**: `src/vite.config.js` gained the anticipated `WEB` `define` entry and a platform-conditional `resolve.alias` (via the plugin above), a separate `outDir` (`build/html-web`), and — since Vite's dev server always serves `<root>/index.html`, never `rollupOptions.input`, so root has to actually change for `client-web/index.html` to be reachable in dev mode — new `dev-web`/`prod-web` npm scripts pass `client-web` as the CLI root with an explicit `--config src/vite.config.js` (config discovery is root-relative by default, so this decouples it). Dev mode also gets a different port (5173, since `serve` already claims 9000) and a `server.proxy` forwarding `/api` (HTTP + the WS upgrade) to a `serve` instance running alongside.
- **Static serving + HTTPS**, both in `server/src/http-server.js`: `serve` now serves `build/html-web` at `/` with an SPA fallback to `index.html` for unmatched non-`/api` paths (client-side routes have no file on disk). Path-traversal-safety note for future editors: neither `path.join` nor `path.resolve` alone is a sandbox — `path.resolve(base, '/etc/passwd')` discards `base` entirely, and `..` segments walk back out through either — the actual guard is the explicit prefix check against the *resolved* path, verified live against both a raw `--path-as-is` traversal and a `%2e%2e`-encoded one (both correctly fall through to the SPA `index.html`, not the real file). Added on top, from a mid-session user request rather than the original plan: opt-in HTTPS (`--tls-cert`/`--tls-key` or `VRCX_SERVER_TLS_CERT`/`VRCX_SERVER_TLS_KEY`, a partial pair is a hard error, not a silent HTTP fallback) via `node:https`, with the session cookie gaining `Secure` automatically whenever TLS is active — verified live with a self-signed cert (login round-trip, `Secure` flag present, a plain-HTTP request against the TLS-only listener correctly failing).

Verified live: `npm run prod-web` builds cleanly; the bundle contains no `SQLite`/`handleSQLiteError`/real-`config.js` markers (checked, not assumed); `curl` round-trips for `/api/login`, `/api/rpc` (real `configRepository`/`database` data against the real, already-logged-in account), static serving (index, and both raw and encoded traversal attempts falling through safely to the SPA shell), and HTTPS end-to-end with a self-signed cert. 65/65 server tests pass.

</details>

<details>
<summary><strong>The live-browser pass</strong> (expand for the six bugs it found, none of which curl/CLI could have caught)</summary>

Opening the built client in real Chrome against a real, already-logged-in account (Claude in Chrome, not a human at a keyboard, but the same "real browser, real account" bar every other phase's live pass used) found six real bugs server-verification had no way to see, each fixed and re-verified against a fresh build/server restart:

1. **The app never rendered at all.** `#root` stayed a bare Vue comment placeholder (`<!---->`, 7 characters — the exact tell). Root cause: `client-web/shims/app-api.js`'s deliberate "throw on anything unimplemented" design (correct for a button click a component can catch) doesn't hold for methods called *unconditionally during boot* — `src/plugins/ui.js`'s `initUi()` calls `AppApi.ChangeTheme`/`CustomCss` synchronously on every app start, with nothing to catch a throw from either. Fixed by implementing `ChangeTheme`/`SetTrayIconNotification` (native window-chrome/tray concerns, correctly no-ops here) and `CustomCss`/`CustomScript` (read a local `custom.css`/`custom.js` file server-side; `''` matches native's own "no such file" default) for real, rather than leaving them to throw.
2. **The same five methods, still throwing, but on a recurring ~60s cycle** (`SetAppLauncherSettings`, `ExecuteVrOverlayFunction`, `GetVRChatRegistryKey`, `HasVRChatRegistryFolder`, `PopulateImageHosts`), alongside three more caught once the app got further (`CurrentCulture`, `GetLaunchCommand`, `CheckGameRunning`, `GetZoom`, `IPCAnnounceStart`) — all genuinely desktop-only concepts (registry, VR overlay, native process/window state) with no browser equivalent, implemented as no-ops or the same trivial constant native's own implementation already returns (e.g. `GetZoom` → `1`, matching `Dotnet/AppApi/Electron/AppApiElectron.cs`'s own hardcoded `return 1`). `window.LogWatcher` was never installed at all — a bare `ReferenceError`, not even a caught `Proxy` throw — new `client-web/shims/log-watcher.js`, same reasoning (game-log tailing is desktop-only, so "no log lines" is the permanent, correct answer, not a stand-in).
3. **`TypeError: r.setNextCurrentUserRefresh is not a function`**, blocking the reactive login-completion chain (`src/stores/auth.js:224`) from ever finishing — `client-web/shims/update-loop.js`'s stub only implemented `updateLoop()`, the one method `src/app.js` calls, but `auth.js`/`authCoordinator.js` call five more of the real store's methods directly (invariant 4 — a stub has to match the *whole* public surface, not just the one call site that happened to be traced first). Fixed by implementing the full nine-member surface as inert no-ops/zeros — the server owns the one real loop regardless.
4. **The pipeline WebSocket connection failed on every attempt** (a toast reading "WebSocket Error", not a caught console error — `src/services/websocket.js`'s own `onerror` handler). Root cause: `websocket.js` (real, unmodified) always builds its URL as `` `${AppDebug.websocketDomain}/?auth=${token}` `` — an unavoidable extra `/` `client-web/bootstrap.js` has no way to prevent, since it only controls `websocketDomain`, not the concatenation. The real request path is `/api/stream/`, but `server/src/http-server.js`'s upgrade handler did an exact-match check against `/api/stream` with no trailing slash and destroyed the socket. Fixed by accepting both.
5. **`Failed to get instance join history: TypeError: e is not iterable`** — `database.getInstanceJoinHistory()` (and, grepped afterward, ~15 other `database.*` methods across 5 files) returns a real `Map`, which `JSON.stringify` silently serializes to `{}` (a `Map` has no own enumerable properties) once it crosses the `/api/rpc` JSON boundary. Fixed generically in `server/src/http-server.js`'s `sendJson` with a `JSON.stringify` replacer converting `Map`→array-of-entries and `Set`→array — lossless for every caller found, since `for (const [k, v] of data)` reads identically off a `Map` or its entries array, and covers every such method at once rather than special-casing this one. Same investigation surfaced a second, narrower issue in `client-web/shims/webapi-target.js`: `Execute()` must never throw per `webapi.js`'s own documented contract (§3.5) — always resolve to `{Item1, Item2}`, even on failure — but it was letting `rpcCall`'s plain `Error` (correct for `db`/`config`) propagate straight through, which `request.js`'s `$throw` then `JSON.stringify`s into a useless `{}`. Fixed by catching and re-wrapping into the tuple shape the real shim's contract requires.

6. **Every avatar in the friends list rendered as fully invisible** — not a broken-image icon, not blank space, just nothing, found on a later live pass (during the TOTP work) rather than the original phase 4 session. The image data itself was loading correctly (`<img>.complete === true`, real `naturalWidth`) — the actual cause was `src/shared/utils/base/ui.js`'s user-avatar CSS `mask-image: url(images/masks/usercutout.svg)`: a masked element with a *failed* mask resource renders as blank rather than falling back to unmasked, which is exactly what made this so easy to miss visually. Root cause was one level further back: Vite resolves `publicDir` relative to `root` by default, and `client-web/` (the web build's root) has no `public/` of its own — `copyPublicDir: true` was therefore silently copying nothing, for *every* asset under `src/public/**` (icons, masks, fonts by absolute path), not just this one mask. `server/src/http-server.js`'s SPA fallback made it worse by quietly serving `index.html` in place of any missing static asset with a `200`, so there was no 404 to notice either. Fixed by pinning `publicDir` to the real `src/public` explicitly in `src/vite.config.js`, independent of which platform's root is active.

After all six: a completely clean console on a fresh load, full login → dashboard → real friends list/feed/saved-accounts (all real SQLite data via `/api/rpc`, avatars included) → green "WebSocket" status indicator with no error toast. The remaining "not available in the web client" throws left in the console belong to methods with no sane web behavior at all (native process launch, IPC to other instances) — expected and consistent with §9's documented scope cut, not new gaps.

</details>

---

### Phase 5 — implemented (2026-08-14), wants a live desktop pass

Decided with the user up front: **"always external."** The Electron desktop build never spawns or embeds a server itself — it always connects to a `serve` instance running elsewhere (Docker, another machine, or manually on the same box). Strictest reading of the split architecture, and it adds no server-lifecycle management to the client at all.

<details>
<summary><strong>What shipped</strong> (expand for the design, and why the scope turned out much narrower than "reimplement 93 methods")</summary>

- **Far less native-capability surface needed reimplementing than the roadmap's own phrasing suggested.** Tracing real call sites (not assumed) found `src-electron/InteropApi.js` already hosts every real .NET object (`AppApiElectron`, `LogWatcher`, `Discord`, `AssetBundleManager`, `AppApiVrElectron`, …) in-process via `node-api-dotnet`, and `src/ipc-electron/interopApi.js` already turns every `window.AppApi.Foo(...)` renderer call into a generic `(className, methodName, args)` IPC round-trip. None of that needed to change — VR overlay, Discord, log tailing, registry and screenshots never touched the database or VRChat's API in the first place, so the renderer's own direct native calls keep working exactly as before. Only `window.SQLite` (unreachable once `database`/`config` are aliased, same fact phase 4 already proved) and `window.WebApi` (VRChat REST + the cookie jar) needed to stop being real .NET objects.
- **The server's `AppApi`/`LogWatcher`/`Discord`/`AssetBundleManager` polyfills** (`server/src/globals.js`) went from "always no-op" to "forward to a connected desktop agent, else no-op" via a shared `createAgentAwarePolyfill(className, overrides)` factory — one `Proxy` shape behind all four, since none has a fixed method list worth enumerating (every call site is a bare `SomeGlobal.SomeMethod(...)`). `LogWatcher`/`Discord`/`AssetBundleManager` were simply undefined globals server-side before this — never dereferenced, because every call site that reaches them was `LINUX`-gated (per phase 2b) except two found by grepping the store/coordinator closure for *unconditional* call sites: `gameLogCoordinator.js`'s `updateGameLog()` (→ `LogWatcher.Get()`) and `discordPresence.js`'s `updateDiscord()` (→ `Discord.SetAssets`/`SetActive`, from `saveDiscordOption()`). Those two are the concrete, already-reachable payoff — no upstream edit needed to "unlock" them, they just start doing something instead of nothing once an agent connects. Deliberately **not** touched: the `LINUX`-gated call sites (e.g. `updateLoop.js`'s own `LogWatcher.GetLogLines()` poll) stay permanently inert on the server exactly as phase 2b left them — invariant 1 forbids editing those call sites to "unlock" them, and doing so would reopen behaviour phase 2b spent real effort proving safe.
- **`server/src/agent.js`** (new): tracks at most one connected desktop agent (same single-account/single-process simplifying cut as §9's existing "single account" entry). `call(className, methodName, args)` sends `{requestId, className, methodName, args}` over the agent's WebSocket and resolves/rejects from the correlated `{requestId, ok, result|error}` reply, with a 10s timeout. A new connection replaces an older one (logged as a warning) rather than fanning out to several — matches how `/api/login` already treats a re-login.
- **Bearer-token auth**: the desktop agent isn't same-origin, so it can't rely on the browser client's `HttpOnly` cookie. `/api/login`'s JSON response now also returns the raw token alongside the existing `Set-Cookie` header (additive — the web client already ignores response fields it doesn't know about), and a new `readSessionToken(req)` (`server/src/http-auth.js`) checks `Authorization: Bearer <token>` first, falling back to the cookie, used by every session check including the new `/api/agent` WS upgrade.
- **`client-desktop/`** (new, mirrors `client-web/`): `shims/{database,config,webapi-target,update-loop}.js` are the same RPC-backed replacements phase 4 built for the browser client, but routed through a new `window.vrcxDesktopAgent.rpc` (`src-electron/preload.js`) instead of `fetch('/api/rpc')` directly — a renderer `fetch` to a remote origin hits real browser CORS, which the server has deliberately never had to answer (phase 4's own design note), and routing through the main process — which already mediates every native call the exact same way — sidesteps that entirely rather than opening a new server-side CORS policy.
- **`src-electron/main.js`**: the `SQLite`/`WebApi` .NET object `Init()` calls are gone entirely — the concrete fix for the single-writer hazard phase 5 exists to close. New `vrcx-connect-server` IPC handler does the actual `/api/login` POST with Node's own `fetch` (immune to CORS, it isn't a renderer), stores `{url, token}` via the existing real `VRCXStorage.Set(...)` (genuinely machine-local config, same category as window geometry per §1), and opens the `/api/agent` WebSocket whose message handler calls the **existing, unmodified** `interopApi.callMethod(...)` — the agent channel's terminus is the exact same function the renderer's own `callDotNetMethod` IPC already uses, not a second implementation of it. A new `vrcx-rpc` handler relays `database`/`config`/`webapi` calls the same way. `createWindow()` now probes the stored session before deciding what to load: a valid one goes straight to the real, unmodified `build/html/index.html`; anything else (including every restart of `serve`, since sessions are process-lifetime only per phase 3) falls through to a new `client-desktop/setup.html` — a server-URL-then-code form needing no Vite build at all, same hand-rolled-DOM approach as `client-web/bootstrap.js`'s own login gate (both gained a first-run QR enrollment step shortly after — see the TOTP section below).
- **Lessons carried over from phase 4's live-browser pass, applied up front instead of rediscovered**: `client-desktop/shims/update-loop.js` shipped with the full real store surface (ten members) from the start, not just `updateLoop()` — phase 4 found the hard way that `auth.js`/`authCoordinator.js` call `setNextCurrentUserRefresh` and friends directly. `client-desktop/shims/webapi-target.js`'s `Execute()` catches and re-wraps any `rpcCall` rejection into the `{Item1, Item2}` tuple its own contract (§3.5) requires, rather than letting a plain `Error` propagate through to collapse into `{}` the way phase 4's first version of the web client's own shim did.

Verified: `npm run prod-linux` builds cleanly, and the output bundle contains no `SQLite`/`handleSQLiteError` markers — checked the same way phase 4 checked its own build, not assumed. `npm run prod-web` still builds unaffected by the new `PLATFORM === 'linux'` alias branch. 85/85 server tests pass (20 new, covering `agent.js`'s request/response correlation and the agent-aware polyfills). **Not yet done**: an actual click-through on a real Electron window against a real `serve` instance — setup screen → real app → a friend's Discord presence updating, a real game-log line arriving over the agent channel — which needs a human at a desktop with VRChat running, the same bar every prior phase's live pass has had.

</details>

---

### TOTP auth — done (2026-08-14), replaces phase 3's static password

Requested mid-phase-5-session: `serve`'s password auth (phase 3) is a static, indefinitely-reusable credential — a real weakness given the common deployment is a home-network Docker container over plain HTTP (this file's own security notes have said so since phase 3). Replaced with RFC 6238 TOTP: a rotating 6-digit code from any standard 2FA app. The *secret* is still the one long-lived credential (same threat model a password hash had), but the *code* itself is worthless outside its 30-second window even if sniffed in transit — the actual improvement, not a cosmetic one.

<details>
<summary><strong>What shipped</strong> (expand for the design, and a real "server won't start" bug the browser-driven flow surfaced)</summary>

- **`server/src/totp.js`** (new): `node:crypto` only, no dependency — HMAC-SHA1 + RFC 4226 dynamic truncation, plus a from-scratch base32 codec (RFC 4648 has no built-in Node support). Verified against RFC 6238 Appendix B's own published test vectors (five fixed `(time, code)` pairs), not just internal round-trip self-consistency — the strongest confidence check available for a from-scratch HOTP/TOTP implementation. `verifyTotpCode` tolerates ±2 steps (60s) of clock skew/round-trip delay, standard TOTP practice — bumped from ±1 step after live testing hit real friction from tool round-trip latency between generating and submitting a code.
- **`server/src/http-auth.js`**: `checkPassword`/`hashPassword`/`setServerPassword`/`hasServerPassword` replaced outright with `checkTotpCode`/`setServerTotp`/`hasServerTotp`, same env-var-then-stored-secret precedence phase 3's password already had (`VRCX_SERVER_TOTP_SECRET` → `configRepository`'s `VRCX_ServerTotpSecret` → refuse to start). Scrypt hashing is gone entirely — a TOTP secret isn't a password, there's nothing to hash, it has to be stored in a form the server can feed back into the same algorithm the user's app runs.
- **Two new routes, deliberately one-shot**: `POST /api/totp/setup` (generates a secret + `otpauth://` provisioning URI, *not* persisted yet) and `POST /api/totp/confirm` (verifies a code against that secret and only then saves it, immediately starting a session — no separate login step after enrolling). Both refuse unconditionally once any secret already exists, authenticated or not — the user explicitly wanted the browser to never be able to show the secret/QR a second time; rotating afterwards is `setup-totp`-CLI-only (shell access to the box is the trust boundary, same bar the original design already implicitly had).
- **A real startup bug the browser-driven flow itself surfaced**: `createHttpServer` originally refused to start at all with no secret configured (inherited from phase 3's password-refuses-to-start design) — which made first-run browser enrollment impossible, since the server would never boot far enough to *serve* the enrollment page. Fixed by letting `serve` start regardless, logging a warning instead of throwing; every route except the two TOTP ones and static file serving still needs a valid session, which is simply unreachable until enrollment finishes, so nothing is actually exposed by starting unconfigured.
- **Both clients' login gates** (`client-web/bootstrap.js`, `client-desktop/setup.js`) gained a first-run branch: `/api/totp/setup`'s status code doubles as "is this server already enrolled?" (200 = no, hands back a secret + URI; 403 = yes) so one probe drives which form renders, no separate flag anywhere. The QR itself is rendered client-side with `qrcode-generator` (new dependency — hand-rolling a correct QR encoder from scratch was judged too high-risk for too little benefit, unlike the TOTP algorithm itself, which is small enough to verify exhaustively against the RFC's own vectors). The desktop build's `setup.html` has no Vite build step at all (loaded raw via `file://`), so it can't use a bare `import qrcode from 'qrcode-generator'` specifier — verified live that the UMD build's top-level `var qrcode = ...` still becomes a real global when loaded via a plain classic `<script>` tag, its own (here-inert) AMD/CommonJS wrapper notwithstanding, and used that instead of standing up a whole second bundler pipeline for one small page.
- **The code input itself** carries `autocomplete="one-time-code"` + `inputmode="numeric"` + `pattern="[0-9]*"` + `name="otp"` — the exact hints Bitwarden and other password managers key off of for TOTP-field autofill detection, the user's original ask.

Verified live end-to-end in a real browser against the real database (Claude in Chrome): fresh `serve` start with no secret logs the warning and still boots; the client renders a real, scannable QR + secret; confirming the current code enrolls and lands straight in the real dashboard with no extra login step; logging out and reloading shows the plain code-only login form, never the QR again; logging back in with a fresh code works. 104/104 server tests pass (19 new: RFC vectors, secret-source precedence, and full-server-instance integration coverage of `/api/login` + both TOTP routes including the one-shot refusal).

</details>

---

### Phase 6 — done (2026-08-14): single-writer lock, awaited client writes, packaging

Same "no pre-written recipe, just the roadmap's one line" situation as phases 3 and 5. Three research passes up front found the real shape of each of the three pieces — narrower than the one-line spec suggested for two of them:

<details>
<summary><strong>What shipped</strong> (expand for the design and why the scope narrowed)</summary>

- **Single-writer lock** (`server/src/lock.js`, new): genuinely needed new code — nothing before this stopped two of this fork's own processes (two `serve`s, or `serve` + `pipeline`) opening the same `VRCX.sqlite3` at once. `server/src/shims/sqlite.js` deliberately runs `locking_mode=NORMAL` (ported from `Dotnet/SQLite.cs`'s own connection string) so short-lived commands (`query`/`tables`/`info`) can coexist with a running `serve` — so SQLite/WAL itself gives no exclusivity signal to build a lock on, and `node:sqlite` has no `SQLITE_OPEN_EXCLUSIVE` equivalent either. Built instead as a hand-rolled PID lockfile (`<database>.lock`) using `fs.openSync(path, 'wx')` — atomic exclusive-create, no new dependency. `acquireLock` cleans up a stale lock (owning pid confirmed dead via `process.kill(pid, 0)`'s `ESRCH`) and retries once; a live lock throws a clear pid-bearing error. `serve`/`pipeline` acquire it right after opening the database and release it on clean shutdown (`installLockReleaseOnExit`'s `process.on('exit', ...)` is the actual release mechanism — the one Node lifecycle hook guaranteed to fire synchronously regardless of how the process exits); `migrate` checks `isLocked` first and refuses unless `--force` is passed, since migrating schema out from under a live writer is the single riskiest combination. `query`/`tables`/`info`/`login`/`whoami`/`logout`/`setup-totp` are unaffected, matching today's behaviour — genuinely fine to run against a live `serve`. Verified live (not just unit-tested): a second `serve` against a locked database refuses with the pid in the error; `migrate` refuses without `--force` and proceeds with it; a clean `SIGTERM` releases the lock and a subsequent `serve` reacquires it normally. This only protects this fork's own processes against each other — it can't stop an old, unmodified upstream desktop build from opening the same file directly, since that build has no idea this lockfile convention exists (§9).
- **Awaited client writes — audited, not rewritten**: the alarming-sounding "86 un-awaited `database.*`/`configRepository.*` call sites" turned out to contain zero actual correctness bugs on inspection — every one is a fire-and-forget write whose return value upstream itself never consumes, by design, and invariant 1 forbids editing these call sites regardless of what the audit found. The real gap: a failed write today ran in-process on the server (where a thrown error surfaces normally) but as an unawaited RPC promise on the `WEB`/Electron clients — nothing was there to catch a rejection, so failures were completely silent. Closed generically with one `installUnhandledRejectionReporting()` (`src/plugins/interopApi.js`, the seam table's own native-globals injection point, already edited for phases 4 and 5's `WEB`/Electron branches) — a `window.addEventListener('unhandledrejection', ...)` reusing the exact `vue-sonner` `toast.error(...)` convention `src/services/request.js` and 13 coordinators already use for API failures, rather than inventing new UX. Deliberately not installed on the `WINDOWS`/CefSharp branch: `window.SQLite` is real and local there, so upstream's original fire-and-forget assumption still holds and there's no RPC hop to swallow a rejection in the first place. Verified live in the real running browser client (Claude in Chrome): a synthetic `Promise.reject(new Error(...))` executed via devtools produced a real toast reading "Something went wrong: `<message>`" — and confirmed, as a side effect, that phase 4's profile-picture/`publicDir` fix (§8) was still holding, since the same screenshot showed real friend avatars rendering correctly.
- **Packaging — scoped to what's verifiable without a working `dotnet`/Electron environment** (confirmed absent in this sandbox: `which dotnet` fails). `client-desktop/README.md` (new) documents the real two-stage build process, traced from `.github/workflows/github_actions.yml`'s own `build_dotnet_linux`/`build_node` jobs rather than invented: `dotnet build 'Dotnet/VRCX-Electron.csproj' -p:Configuration=Release ... -a x64` (output `build/Electron/`) followed by `npm run prod-linux && npm run build-electron` (the latter also runs `download-dotnet-runtime.js`, a separate network fetch from the `dotnet build` step) — a sequence that previously existed only implicitly inside that CI workflow, with zero doc anywhere a fork user could find it. Also documents how first-run connects to a `serve` instance via `client-desktop/setup.html`'s TOTP-aware setup flow. Linked from the root `README.md` and `server/README.md`. `package.json`'s `build.linux.maintainer` (still `rs189`'s upstream identity) was considered for a fork-identity change but explicitly left alone on request — electron-builder's `maintainer` is a single string with no array/list support, and displacing the original maintainer wasn't the intent; adding a proper co-credit would need npm's own `contributors` field or similar, not attempted this pass. Explicitly out of scope, and documented as such in `client-desktop/README.md` and §9: a fork-adapted Electron CI workflow, and shrinking the bundled `.NET`/`node-api-dotnet` footprint — both need a real `dotnet` + Electron toolchain to build and verify against, which this sandbox doesn't have, so neither was attempted blind.

104 pre-phase-6 server tests plus 10 new (`server/test/lock.test.js`: acquire/release round-trip, stale-lock cleanup via a fake dead pid, refusal against a live pid, unparsable-lockfile handling) all pass — 114/114. `npm run lint` and `npm run test:server` clean on every touched file. `npm run prod-web`/`npm run prod-linux` both still build clean with the new `interopApi.js` code included.

</details>

---

## 10. The container

`server/Dockerfile` (build context is the **repo root**, not `server/`), published by `.github/workflows/server-docker.yaml` to `ghcr.io/<owner>/vrcx-headless-server` for `linux/amd64` and `linux/arm64`. Working and done — user-facing docs are in `server/README.md`.

<details>
<summary>Design rationale</summary>

The one real design decision: **the image installs `server/package.json`, not the root manifest.** The root keeps everything in `devDependencies`, so `--omit=dev` installs nothing while `--include=dev` drags in electron and vite. The image layout mirrors a dev checkout — `/app/{node_modules,src,server}` — so Node resolves `src/**`'s bare imports upward exactly as it does locally, and `server/hooks.mjs` derives `repoRoot` from its own location with no special casing.

The cost is that dependency versions are stated twice. `server/scripts/check-deps.js` runs in CI and fails the build if the two manifests disagree, because a container silently running a different Vue than the client was built against is a genuinely nasty bug.

Every dependency is pure JS — `node:sqlite` is built into the Node binary — so there is nothing to compile, Alpine/musl is safe, and the arm64 build under QEMU is cheap.

CI builds the native-arch image and boots it (`migrate --create`, `--help`) **before** publishing, so a broken image never reaches the registry. Pull requests build and smoke-test without pushing.

</details>

---

## 9. Known limitations

- **Single account.** `dbVars.userPrefix` names tables per VRChat account and is a mutable global set at login. One server process serves one account. Multi-account means one process per account, or making the prefix request-scoped (invasive).
- **Two settings stores.** `configRepository` (SQLite `configs`) moves to the server; `VRCXStorage` (`VRCX.json`) is machine-local and stays desktop-side. Phase 4 gave the web client a `localStorage`-backed stub (`client-web/shims/vrcx-storage.js`) — an explicit stub, not full parity, since a browser tab has no real analogue for e.g. desktop window geometry.
- **Write semantics — audited (phase 6).** All 86 un-awaited `database.*`/`configRepository.*` call sites across `src/services/`, `src/stores/`, `src/coordinators/` were traced: every one is a write whose return value upstream itself never consumes, by design — there is no "client stores a promise it forgot to check" correctness bug, and invariant 1 forbids editing these call sites regardless. The real gap was that a failed write was completely silent on the RPC-backed clients (`WEB`/Electron); phase 6 closed it generically with one `unhandledrejection` listener (`src/plugins/interopApi.js`) reporting via the existing `vue-sonner` toast convention, verified live by triggering a real rejection in the browser.
- **Phase 4's `AppApi` capability coverage is still not exhaustive**, though it's grown from an initial 3 to 14 real implementations (`client-web/shims/app-api.js`) — everything left throws "not available in the web client". The remainder is genuinely native-only (VR overlay, Discord RPC, registry, screenshots, game launch, `CopyImageToClipboard(path)` — a file path a browser has no access to). Any UI control wired to one of those will visibly fail rather than silently no-op — expected, but not swept for which controls that affects. Two of the fourteen (`SendIpc`, `GetVRChatUserModeration`) were found post-phase-6, not during the original live-browser pass: both are called unconditionally from `showUserDialog()` on *every* profile open, and since the Proxy's default throw is synchronous, the first one aborted the rest of that (synchronous) function before the real user fetch ever ran — every profile dialog got stuck on "loading" with placeholder data. Fixed the same way as the rest of this list: a no-op / the same "nothing here" default native itself returns when the underlying file doesn't exist, not a stand-in for real behaviour.
- **The remaining "throws for everything else" default now also toasts.** Requested mid-session: several call sites wrap their `AppApi.*` call in their own `.catch()`/try-catch that just `console.error`s and moves on — this Proxy's own header comment assumed "a UI handler can catch it and disable/hide the control", but a handler that just swallows and logs leaves a real user watching the screen see nothing at all. `client-web/shims/app-api.js`'s Proxy now calls `toast.error(message)` itself, at the throw site, before throwing — covering both that swallowed case and the case nothing catches at all. The second case overlaps with phase 6's own `installUnhandledRejectionReporting()` (`src/plugins/interopApi.js`) once a rejection reaches it, which would otherwise double-toast the same single failure — found live (a raw `Promise.reject` probe with `[data-sonner-toast]` DOM inspection showed two stacked toasts for one throw) and fixed with an `error.alreadyToasted` flag the Proxy sets and the listener checks before toasting again. Verified live, both paths: a swallowed call still toasts exactly once, and a fully-unhandled call also toasts exactly once, not twice.
- **Test coverage upstream is thin at the seam.** One test covers ~190 repository methods (`src/services/database/__tests__/gameLog.test.js`). `server/test/db.test.js` is currently the closest thing to a migration regression test.
- **Node version.** The root `package.json` requires Node ≥24.15. The server itself only needs ≥22.5 (for `node:sqlite` with `setReturnArrays`).
- **One desktop agent at a time**, same simplifying cut as "Single account" above — a second Electron instance connecting to the same server replaces the first agent's connection (`server/src/agent.js`) rather than fanning out to both.
- **No server lifecycle management on the desktop side.** Phase 5's "always external" decision means the Electron client never starts a `serve` instance itself. If one isn't running, or restarts mid-session (sessions are process-lifetime only, per phase 3), the desktop client falls back to `client-desktop/setup.html` on next launch rather than trying to recover automatically.
- **`speechSynthesis` is still a stub everywhere**, including after phase 5. §3.7 flagged "phase 5: route to a desktop agent" for real TTS output, but the agent channel that shipped is request/response (server calls out, agent answers) — routing an ongoing audio stream through it wasn't part of this phase's scope and remains unclaimed follow-up work, not something phase 5 turned out to need.
- **Phase 5 has not had a live desktop pass.** Server-side (the agent protocol, bearer auth) and the build (`npm run prod-linux`, bundle contents) are verified; an actual Electron window connecting to a real `serve` instance and exercising a real Discord presence update or game-log line over the agent channel needs a human at a desktop with VRChat running — the same bar phase 4 closed with its own live-browser pass, not yet repeated here.
- **No fork-adapted Electron CI, and the bundled `.NET`/`node-api-dotnet` footprint hasn't been shrunk.** `.github/workflows/github_actions.yml` is still upstream's own Windows/CefSharp + Azure-signing pipeline; `client-desktop/README.md` (phase 6) documents the manual build sequence traced from it, but automating that into a real fork CI workflow, or reducing how much of `node-api-dotnet` ships, both need a real environment with `dotnet` and Electron's native toolchain installed — confirmed absent in this sandbox (`which dotnet` fails) — so neither was attempted blind, per this project's own "never claim untested work as done" discipline.
- **The single-writer lock (phase 6) only protects this fork's own processes against each other.** `server/src/lock.js`'s PID lockfile can't stop an old, unmodified upstream desktop build from opening the same `VRCX.sqlite3` directly — that build has no idea the lockfile convention exists. The "don't run both at once" warning in `server/README.md` still applies regardless.
