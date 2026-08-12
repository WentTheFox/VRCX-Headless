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
| `server/**` | ours | The headless server. |
| `client-web/**` | ours | Browser-client shims (phase 4). |
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
- **Applies the alias map.** Keyed by *resolved absolute path*, so it does not matter whether a module writes `../stores`, `../../stores/index.js`, or anything else. This is deliberately more robust than Vite's specifier-based aliases.

It also forces `format: 'module'` for files under `src/`, because the root `package.json` has no `"type": "module"` and Node would otherwise parse them as CommonJS.

Vitest has its own module pipeline and never sees the Node hook, so `server/vite-alias-plugin.js` re-implements the same logic as a Vite plugin. **Both read `server/aliases.js`**, so the two paths cannot drift.

### 3.2 Compile-time globals (`server/src/globals.js`)

Vite's `define` block (`src/vite.config.js`) replaces `LINUX`, `WINDOWS`, `VERSION`, `NIGHTLY` at build time. Under Node they are installed as real globals, plus `window = globalThis` so module-scope assignments like `window.database = database` work.

Both platform flags are **false** on the server: it is neither the CEF/Windows build nor the Electron/Linux build. `src/services/sqlite.js` branches only on `LINUX`, so this selects the plain `SQLite.Execute` path.

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

### 3.5 Schema version

`server/src/db.js` **reads the target version out of `src/stores/vrcx.js`** with a regex rather than duplicating the constant, so an upstream bump is picked up automatically instead of silently skipping migrations. If the regex stops matching, it logs a warning and falls back to 16 — treat that warning as a merge task.

---

## 4. Seam table

The modules where the split happens. On an upstream merge, these are what to inspect.

| Seam | Upstream file | Width | Server side | Client side (phase 4) |
|---|---|---|---|---|
| SQL transport | `src/services/sqlite.js` | 2 methods; the **only** `window.SQLite` caller | real `node:sqlite` via `server/src/shims/sqlite.js` | unused — client never sees SQL |
| DB repository | `src/services/database/index.js` | flat ~190-method facade, 206 call sites | imported unmodified | `Proxy` → `rpc('db', name, args)` |
| Config KV | `src/services/config.js` | 12 methods, ~540 call sites | imported unmodified | RPC + write-through cache |
| VRChat HTTP | `src/services/webapi.js` | 4 methods; the **only** `window.WebApi` caller | undici + tough-cookie (phase 2) | proxied via server |
| Pipeline WS | `src/services/websocket.js` | `handlePipeline` switch | connects to VRChat (phase 2) | subscribes to server stream, calls the same `handlePipeline` |
| Daemon | `src/stores/updateLoop.js` | 1 Hz counter loop | runs here, and only here | no-op store |
| Native globals | `src/plugins/interopApi.js` | 42 lines; the **only** injection point | n/a | third `WEB` branch |

### Current alias map (`server/aliases.js`)

| Aliased upstream module | Replaced by | Why |
|---|---|---|
| `src/stores/index.js` | `server/src/shims/stores.js` | `src/services/sqlite.js` imports `useModalStore` to show DB-error dialogs. The real barrel pulls all 36 Pinia stores and, transitively, Vue components. |
| `src/plugins/i18n.js` | `server/src/shims/i18n.js` | Builds a vue-i18n instance and eagerly imports every locale bundle; the data layer only calls `i18n.global.t`. |
| `src/shared/utils/index.js` | `server/src/shims/shared-utils.js` | Only `openExternalLink` is needed; the real barrel re-exports a large DOM/canvas/AppApi tree. |

Phase 2 replaces the `stores` alias with a real Pinia instance for the background stores. The modal stub stays forever — a headless process has no dialogs.

---

## 5. Patch inventory

Every modification to an upstream-owned file. Keep this exhaustive and keep it short.

| File | Change | Why not an alias | Anchor |
|---|---|---|---|
| `package.json` | `name`, `description`, `homepage`, `bugs`, `repository` retargeted at the fork; added `test:server` and `server` scripts | Package identity cannot be aliased | top-of-file metadata block; `scripts` after `"test:coverage"` |
| `.github/workflows/ci.yaml` | Re-enabled the `pull_request` trigger (upstream ships it commented out) and added `push` on `main` | CI config cannot be aliased | `on:` block at the top |
| `.gitignore` | Added `!CLAUDE.md` — upstream ignores AI guidance files, but this one is the fork's maintenance guide and must be tracked | Ignore rules cannot be aliased | after the `AGENTS.md` / `AI_GUIDE.md` / `CLAUDE.md` lines |

Nothing under `src/`, `Dotnet/`, or `src-electron/` has been modified yet. Phase 4 will add exactly one expected entry (`src/plugins/interopApi.js`) plus the `define` block in `src/vite.config.js`.

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

```bash
npm run server -- info                      # where the DB is, what version it is
npm run server -- migrate [--user=usr_...]  # run the JS migration layer
npm run server -- tables                    # row counts per table
npm run server -- query "SELECT ..."        # read-only, positional rows
npm run test:server
```

Environment: `VRCX_DATABASE` (explicit DB path), `VRCX_DATA_DIR` (app data directory), `VRCX_LOG_LEVEL` (`debug|info|warn|error`).

`--user` is only needed to create per-user tables for an account the database has never seen; migrations for existing accounts discover their tables through `sqlite_schema` queries.

---

## 8. Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Fork hygiene: upstream remote, unshallow, identity, CI on PRs | **done** |
| 1 | Server skeleton: SQLite shim, alias/loader layer, migrations, CLI, tests | **done** |
| 2 | Server owns VRChat: `undici`+`tough-cookie` WebApi shim, pipeline WebSocket, Pinia-in-Node for background stores, `updateLoop` daemon | not started |
| 3 | Transport: password auth → session cookie, generic `/api/rpc` dispatcher, `/api/stream` WebSocket fan-out | not started |
| 4 | Web client: `PLATFORM=web`, `client-web/shims/**`, `capabilities` gating | not started |
| 5 | Desktop client as native agent: log forwarding up, overlay/Discord/notification commands down; .NET stops touching SQLite | not started |
| 6 | Hardening: single-writer lock, awaited client writes, packaging | not started |

### Phase 2 notes (next up)

- `src/services/request.js` imports `vue-sonner`, `i18n`, and the modal store, and performs auth side effects inline on 401/403. Aliasing gets it running; its error *reporting* becomes a stream event. This is the most likely source of real conflicts in future merges.
- Pinia runs in Node via `createPinia()` + `setActivePinia()`. Store reactivity is load-bearing for business logic (e.g. `friend.js` derived lists), not just rendering — keep it rather than rewriting.
- `src/services/security.js` uses `window.crypto.subtle`, which exists natively in Node; reuse as-is.
- Standardise the game-log delivery path on the queue/poll side (`LogWatcher.GetLogLines()`). The Windows path currently pushes via `ExecuteScriptAsync("window?.$pinia?.gameLog.addGameLogEvent", ...)`, a string coupling that cannot survive the split.

---

## 9. Known limitations

- **Single account.** `dbVars.userPrefix` names tables per VRChat account and is a mutable global set at login. One server process serves one account. Multi-account means one process per account, or making the prefix request-scoped (invasive).
- **Two settings stores.** `configRepository` (SQLite `configs`) moves to the server; `VRCXStorage` (`VRCX.json`) is machine-local and stays desktop-side. The web client needs a stub for the latter.
- **Write semantics.** Most `feed.js`/`gameLog.js` writers are non-`async` fire-and-forget. In-process on the server that is fine; the ~12 client-side write call sites in `.vue` files must `await` their RPC and surface errors.
- **Test coverage upstream is thin at the seam.** One test covers ~190 repository methods (`src/services/database/__tests__/gameLog.test.js`). `server/test/db.test.js` is currently the closest thing to a migration regression test.
- **Node version.** The root `package.json` requires Node ≥24.15. The server itself only needs ≥22.5 (for `node:sqlite` with `setReturnArrays`).
