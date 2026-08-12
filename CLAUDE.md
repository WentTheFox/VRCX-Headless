# VRCX-Headless — fork architecture and upstream migration guide

This fork splits [VRCX](https://github.com/vrcx-team/VRCX) into two pieces:

- a **headless server** that owns the VRChat API connection and is the *sole writer* of `VRCX.sqlite3`
- a **client** — the existing Vue app — that runs either in a browser or inside the Electron desktop shell, and stays in sync across devices off a server event stream

Upstream is a fast-moving, UI-heavy project, and `.github/CONTRIBUTING.md` says UI PRs are declined there, so **everything we diverge on is permanently ours to maintain**. This document exists to make each upstream merge mechanical rather than archaeological.

**If you are an agent or contributor about to change something: read "Invariants" first. They are the whole reason this fork is maintainable.**

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

### 3.7 Node's missing browser globals

Verified against the running Node, not assumed. `fetch`, `WebSocket`, `crypto.subtle` and `Blob` are present. These are not:

| Missing | Where it bites | Handling |
|---|---|---|
| `CloseEvent` | `src/services/websocket.js:118` — reconnect dies silently | polyfilled in `server/src/globals.js` |
| `Worker` | `worker-timers` builds its timer from a blob-URL Worker; **fails on first call, not on import** | `packageAliases` → `server/src/shims/worker-timers.js` |
| `navigator.onLine` | `src/coordinators/authAutoLoginCoordinator.js:14` reads it → falsy → "you're offline" forever | inject `() => true` (the function already takes it as a parameter) |
| `speechSynthesis` | `src/stores/settings/notifications.js` TTS | phase 5: route to a desktop agent |

### 3.8 Schema version

`server/src/db.js` **reads the target version out of `src/stores/vrcx.js`** with a regex rather than duplicating the constant, so an upstream bump is picked up automatically instead of silently skipping migrations. If the regex stops matching, it logs a warning and falls back to 16 — treat that warning as a merge task.

---

## 4. Seam table

The modules where the split happens. On an upstream merge, these are what to inspect.

| Seam | Upstream file | Width | Server side | Client side (phase 4) |
|---|---|---|---|---|
| SQL transport | `src/services/sqlite.js` | 2 methods; the **only** `window.SQLite` caller | real `node:sqlite` via `server/src/shims/sqlite.js` | unused — client never sees SQL |
| DB repository | `src/services/database/index.js` | flat ~190-method facade, 206 call sites | imported unmodified | `Proxy` → `rpc('db', name, args)` |
| Config KV | `src/services/config.js` | 12 methods, ~540 call sites | imported unmodified | RPC + write-through cache |
| VRChat HTTP | `src/services/webapi.js` | 4 methods; the **only** `window.WebApi` caller | `fetch` + tough-cookie via `server/src/shims/webapi.js` | proxied via server |
| Pipeline WS | `src/services/websocket.js` | `handlePipeline` switch | phase 2b (2a uses a temporary connector) | subscribes to server stream, calls the same `handlePipeline` |
| Daemon | `src/stores/updateLoop.js` | 1 Hz counter loop | runs here, and only here | no-op store |
| Native globals | `src/plugins/interopApi.js` | 42 lines; the **only** injection point | n/a | third `WEB` branch |

### Current alias map (`server/aliases.js`)

| Aliased upstream module | Replaced by | Why |
|---|---|---|
| `src/stores/index.js` | `server/src/shims/stores.js` | `src/services/sqlite.js` imports `useModalStore` to show DB-error dialogs. The real barrel pulls all 36 Pinia stores and, transitively, Vue components. |
| `src/plugins/i18n.js` | `server/src/shims/i18n.js` | Builds a vue-i18n instance and eagerly imports every locale bundle; the data layer only calls `i18n.global.t`. |
| `src/shared/utils/index.js` | `server/src/shims/shared-utils.js` | Only `openExternalLink` is needed; the real barrel re-exports a large DOM/canvas/AppApi tree. |
| `worker-timers` *(package)* | `server/src/shims/worker-timers.js` | Schedules through a blob-URL Web Worker; `Worker` does not exist in Node, and it fails on first call rather than at import. Node has no timer throttling to dodge. |
| `vue-sonner` *(package)* | `server/src/shims/toast.js` | `src/services/request.js`, `websocket.js` and 13 coordinators report every failure as a toast. Headless, they become log lines; from phase 3, stream events. |

Phase 2b replaces the `stores` alias with a real Pinia barrel for the background stores. The modal stub stays forever — a headless process has no dialogs.

### The store-graph problem (measured, not estimated)

Importing *any* background store today pulls a **629-file closure including ~300 `src/components/**` and ~144 `src/views/**`**, through exactly two edges:

- `src/stores/settings/appearance.js:29` → `src/plugins/index.js` (a barrel re-exporting `./components` and `./router`)
- `src/stores/avatarProvider.js:4` → `src/plugins/router.js`

Aliasing those two drops it to **148 files and 11 npm packages**. That is why phase 2 was split: 2a avoids the store layer entirely, 2b takes it on. Full recipe in §8.

One benign-looking edge to leave alone: `src/stores/gameLog/index.js:5` imports `src/views/GameLog/sessions/buildGameLogSessions.js`, which is a pure function that merely lives under `views/`. Do not add a path-prefix rule that rejects it — and note `.dockerignore` keeps `src/**` whole for this reason.

---

## 5. Patch inventory

Every modification to an upstream-owned file. Keep this exhaustive and keep it short.

| File | Change | Why not an alias | Anchor |
|---|---|---|---|
| `package.json` | `name`, `description`, `homepage`, `bugs`, `repository` retargeted at the fork; added `test:server` and `server` scripts; added `tough-cookie` to `devDependencies` | Package identity and scripts cannot be aliased. `tough-cookie` is declared so local dev does not depend on it being hoisted as somebody else's transitive dep — it is also a real dependency in `server/package.json`, and `server/scripts/check-deps.js` enforces the two match | top-of-file metadata block; `scripts` after `"test:coverage"`; `devDependencies` after `"tailwindcss"` |
| `.github/workflows/ci.yaml` | Re-enabled the `pull_request` trigger (upstream ships it commented out) and added `push` on `main` | CI config cannot be aliased | `on:` block at the top |
| `.gitignore` | Added `!CLAUDE.md` — upstream ignores AI guidance files, but this one is the fork's maintenance guide and must be tracked | Ignore rules cannot be aliased | after the `AGENTS.md` / `AI_GUIDE.md` / `CLAUDE.md` lines |
| `README.md` | Added a short "About this fork" block pointing at `server/README.md` and this file | Docs cannot be aliased. Kept to a pointer on purpose: the real server documentation lives in `server/README.md`, which is ours and carries no merge surface | immediately before `# Getting Started` |

Nothing under `src/`, `Dotnet/`, or `src-electron/` has been modified. Phase 4 will add exactly one expected entry (`src/plugins/interopApi.js`) plus the `define` block in `src/vite.config.js`.

### Temporary scaffolds (not patches, but debts)

| Where | What | Removed by |
|---|---|---|
| `server/src/vrchat.js` | Drives the 4 auth endpoints and the pipeline connection directly instead of through `src/services/request.js` / `src/services/websocket.js`, because both drag in the 629-file store closure | phase 2b, which switches to `src/api/auth.js` and the real websocket module |

Do not grow that file. Anything added to it is divergence phase 2b has to unpick.

---

## 6. Upstream sync procedure

Upstream's default branch is **`master`**; ours is **`main`**. The `upstream` remote is `https://github.com/vrcx-team/VRCX.git`.

```bash
git fetch upstream master
git checkout -b sync/<date> main
git merge upstream/master
```

### 6.1 Expected conflicts, ranked

1. `package.json` — dependency bumps land next to our identity/scripts changes. Keep both sides; take upstream's dependency block wholesale.
2. `.github/workflows/ci.yaml` — take upstream's job definitions, keep our `on:` block.
3. *(from phase 4)* `src/plugins/interopApi.js`, `src/vite.config.js`, `src/App.vue`, `src/stores/updateLoop.js`.

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
| 2b | Pinia-in-Node: the background stores and the `updateLoop` daemon | next up |
| 3 | Transport: password auth → session cookie, generic `/api/rpc` dispatcher, `/api/stream` WebSocket fan-out | not started |
| 4 | Web client: `PLATFORM=web`, `client-web/shims/**`, `capabilities` gating | not started |
| 5 | Desktop client as native agent: log forwarding up, overlay/Discord/notification commands down; .NET stops touching SQLite | not started |
| 6 | Hardening: single-writer lock, awaited client writes, packaging | not started |

### Phase 2b recipe (next up)

Ordered so each step is independently verifiable. Steps 1–2 are the ones that make the graph loadable at all.

1. **Alias the two component/view edges** — `src/plugins/index.js` (must export `loadLocalizedStrings` plus the i18n re-exports) and `src/plugins/router.js` (must export a `router` with `currentRoute` as a ref and a `push()`). 629 files → 148.
2. **Alias `src/stores/activity.js`** — it reaches `src/workers/activityWorkerRunner.js:1`, which imports `./activityWorker.js?worker&inline`. That is Vite-only syntax and fails at *resolve* time, so it cannot be deferred. Reached from `src/stores/auth.js:34`.
3. **Alias `src/stores/ui.js`** — calls `document.body.addEventListener` at store-setup scope (`:273`) and pulls `@vueuse/core` via `useMagicKeys()` (`:31`).
4. **Replace the `src/stores/index.js` stub with a real barrel** minus the UI stores. 17 files in the reduced closure import from it, including `src/services/request.js`, `src/services/websocket.js` and 10 modules under `src/api/**`.
5. **Mount a throwaway `createApp({})`** with pinia, a memory router and real vue-i18n. `createPinia()` + `setActivePinia()` alone leaves `pinia._a` unset, so `inject()` returns `undefined` and `useRouter()` / `useI18n()` throw at store-setup time in ~20 stores. Mounting keeps upstream signatures intact (invariant 4) and is cheaper than aliasing `vue-router` and `vue-i18n`.
6. **Narrow `window`.** `server/src/globals.js` currently sets `window = globalThis`, which makes `typeof window !== 'undefined'` true and defeats the SSR guards in `@tanstack/query-core` and `@vueuse/core`. Replace it with a narrow object carrying only the properties `src/**` actually assigns (`$debug`, `utils`, `dayjs`, `database`, `configRepository`, `sqliteService`, `webApiService`, `gameLogService`, `request`).
7. **Delete the `server/src/vrchat.js` scaffold** in favour of `src/api/auth.js`, `src/services/request.js` and `src/services/websocket.js` + `handlePipeline`.
8. **Run `src/stores/updateLoop.js`** as the daemon; leave the desktop-only counters (Discord 3 s, app update, registry backup) inert until phase 5.
9. **`AppApi` stub** — a Proxy over the ~81 methods returning no-ops. The server needs `PopulateImageHosts` (called from `handleConfig`), `CheckGameRunning`, `IPCAnnounceStart` and `FlashWindow`. Build it shared, since phase 4 needs the same shape client-side.

**Login is `watch`-driven, which is why step 5 is unavoidable.** `loginComplete()` (`src/stores/auth.js:1011`) sets `watchState.isLoggedIn`; a watcher at `src/stores/friend.js:382` runs the friends init; that sets `isFriendsLoaded`; and a `{flush:'sync'}` watcher at `src/stores/auth.js:110` is what actually opens the pipeline WebSocket. `watchState` (`src/services/watchState.js`) is a plain `reactive()` object and is the system's clock — there is no imperative equivalent, so reactivity must be preserved rather than rewritten.

Other notes carried forward:

- `src/services/request.js` performs auth side effects inline on 401/403 (`handleAutoLogin`, the 2FA dialog, a VPN modal on 403 `config`). Aliasing gets it running; its error *reporting* becomes a stream event. Most likely source of real conflicts in future merges.
- It also holds an in-flight GET dedupe (10 s, keyed by URL) and a negative cache (15 min, keyed by endpoint, exported and mutable). Both become server-wide once it runs here — clear `failedGetRequests` on relogin.
- `src/services/security.js` uses `window.crypto.subtle`, which exists natively in Node; reuse as-is.
- Standardise the game-log delivery path on the queue/poll side (`LogWatcher.GetLogLines()`). The Windows path currently pushes via `ExecuteScriptAsync("window?.$pinia?.gameLog.addGameLogEvent", ...)`, a string coupling that cannot survive the split.

---

## 10. The container

`server/Dockerfile` (build context is the **repo root**, not `server/`), published by `.github/workflows/server-docker.yaml` to `ghcr.io/<owner>/vrcx-headless-server` for `linux/amd64` and `linux/arm64`. User-facing docs are in `server/README.md`.

The one real design decision: **the image installs `server/package.json`, not the root manifest.** The root keeps everything in `devDependencies`, so `--omit=dev` installs nothing while `--include=dev` drags in electron and vite. The image layout mirrors a dev checkout — `/app/{node_modules,src,server}` — so Node resolves `src/**`'s bare imports upward exactly as it does locally, and `server/hooks.mjs` derives `repoRoot` from its own location with no special casing.

The cost is that dependency versions are stated twice. `server/scripts/check-deps.js` runs in CI and fails the build if the two manifests disagree, because a container silently running a different Vue than the client was built against is a genuinely nasty bug.

Every dependency is pure JS — `node:sqlite` is built into the Node binary — so there is nothing to compile, Alpine/musl is safe, and the arm64 build under QEMU is cheap.

CI builds the native-arch image and boots it (`migrate --create`, `--help`) **before** publishing, so a broken image never reaches the registry. Pull requests build and smoke-test without pushing.

---

## 9. Known limitations

- **Single account.** `dbVars.userPrefix` names tables per VRChat account and is a mutable global set at login. One server process serves one account. Multi-account means one process per account, or making the prefix request-scoped (invasive).
- **Two settings stores.** `configRepository` (SQLite `configs`) moves to the server; `VRCXStorage` (`VRCX.json`) is machine-local and stays desktop-side. The web client needs a stub for the latter.
- **Write semantics.** Most `feed.js`/`gameLog.js` writers are non-`async` fire-and-forget. In-process on the server that is fine; the ~12 client-side write call sites in `.vue` files must `await` their RPC and surface errors.
- **Test coverage upstream is thin at the seam.** One test covers ~190 repository methods (`src/services/database/__tests__/gameLog.test.js`). `server/test/db.test.js` is currently the closest thing to a migration regression test.
- **Node version.** The root `package.json` requires Node ≥24.15. The server itself only needs ≥22.5 (for `node:sqlite` with `setReturnArrays`).
