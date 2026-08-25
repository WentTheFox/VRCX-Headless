# VRCX Headless Server

The headless half of [VRCX-Headless](https://github.com/WentTheFox/VRCX-Headless): a Node process that owns `VRCX.sqlite3` and the VRChat API connection, so the UI can run in a browser or on several devices at once without racing on the database.

It runs VRCX's **real** data layer — `src/services/database/**` and `src/services/config.js` are imported unmodified — so it stays in step with upstream instead of forking it. See [`CLAUDE.md`](../CLAUDE.md) for how that works and what the rules are.

> **Status: phases 0–5 done** (see [`CLAUDE.md`](../CLAUDE.md) for the full roadmap). The server owns the database and the VRChat connection, runs the real background stores and the `updateLoop` daemon, and serves an authenticated HTTP/WS API (`serve`) — TOTP auth, a generic `/api/rpc` dispatcher over `database`/`configRepository`/`WebApi`, and `/api/stream` relaying the VRChat pipeline verbatim. Both a browser client (`client-web/`) and an Electron desktop agent (`client-desktop/`) talk to it.

---

## Docker (recommended, incl. Raspberry Pi)

Images are published to GHCR for `linux/amd64` and `linux/arm64`, so a 64-bit Raspberry Pi OS on a Pi 3/4/5 works directly.

```bash
docker pull ghcr.io/wentthefox/vrcx-headless-server:main
```

Create the database (or point at an existing one — see _Using an existing VRCX install_):

```bash
mkdir -p ~/vrcx-data
docker run --rm -v ~/vrcx-data:/data \
  ghcr.io/wentthefox/vrcx-headless-server:main migrate --create
```

Log in to VRChat. This needs `-it`, because it prompts for your password and 2FA code:

```bash
docker run --rm -it -v ~/vrcx-data:/data \
  ghcr.io/wentthefox/vrcx-headless-server:main login
```

Check it worked, then watch live events:

```bash
docker run --rm -v ~/vrcx-data:/data ghcr.io/wentthefox/vrcx-headless-server:main whoami
docker run --rm -v ~/vrcx-data:/data ghcr.io/wentthefox/vrcx-headless-server:main pipeline
```

Your VRChat session cookie is stored in `VRCX.sqlite3` on the volume, so later commands do not ask you to log in again.

### docker compose

```yaml
services:
    vrcx:
        image: ghcr.io/wentthefox/vrcx-headless-server:main
        volumes:
            - ./vrcx-data:/data
        ports:
            - '9000:9000'
        environment:
            VRCX_LOG_LEVEL: info
            # Skips browser-driven enrollment (see "TOTP setup" below) —
            # generate one from a checkout with:
            #   node --input-type=module -e "import('./server/src/totp.js').then(({generateTotpSecret}) => console.log(generateTotpSecret()))"
            VRCX_SERVER_TOTP_SECRET: ...
        command: serve
        restart: unless-stopped
```

### Tags

Release tags are `<vrcx-date-no-dots>.<minor>.<patch>` — real semver, with the VRCX version this release is built against as the *major* number. MINOR bumps on a change that needs this server container itself redeployed/restarted to take effect (server code, the shared data layer, DB schema); PATCH bumps on a client-only change (desktop/web UI) that doesn't, and resets to `0` whenever MINOR bumps. `20260718.1.0` means: built against VRCX `2026.07.18`, the first server-requiring fork release cut against that base. A later client-only release against the same MINOR is `20260718.1.1`; a later server-requiring release is `20260718.2.0`; syncing to a newer VRCX release resets both counters, e.g. `20260801.1.0`.

| Tag             | What it is                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `main`           | latest build of the default branch                                     |
| `sha-<short>`    | a specific commit                                                      |
| `20260718.1.0`   | one exact, immutable fork release                                      |
| `20260718.1`     | floating: latest PATCH under that MINOR — this one *does* move on a client-only release, since the server code behind it hasn't changed |
| `20260718`       | floating: latest fork release built against VRCX `2026.07.18`          |
| `latest`         | most recent release tag                                                |

`docker inspect`'s `org.opencontainers.image.version` label and `... info`'s `server version` line both show the full `20260718.1.0` version (the `info` line also repeats the dotted `2026.07.18` for readability). Maintainers: see CLAUDE.md's "Server/Docker versioning" for how to cut a release.

### Desktop client auto-updates

The Windows desktop client updates itself automatically, but only in response to *this server's* version — not GitHub in general. On every connect (and every server switch), it asks the connected server what version it's running and, if a newer release is available **under that server's own MINOR version**, downloads and installs it for you, no confirmation needed.

"Under that server's own MINOR" matters because PATCH releases are client-only by definition — the server never needed a code change or a redeploy to produce one, so the running server's own PATCH can genuinely lag behind the newest one published. The client isn't held back by that: it's offered the newest PATCH under the server's MINOR even if the server itself is still reporting an older PATCH. A MINOR mismatch is different — that always means the server container itself was rebuilt, and is still the trigger for the client to move onto a whole new release line.

That means **the server never updates itself** — updating it (i.e. bumping MINOR) is always a manual step, same as any other container here: bump the image tag (`docker compose pull` + recreate, e.g. via `docker compose up -d` or your own restart tooling) to whichever floating tag you track (`20260718`, `20260718.1`, or a pinned `20260718.1.0`). Once the container comes back up on the new version, any desktop client connected to it will catch up on its own the next time it reconnects. A client with no server connection, or connected to a server whose MINOR hasn't changed, just picks up newer PATCH releases on its own without anyone touching the server at all.

---

## Running from a checkout

Requires Node ≥ 22.5 for the server itself (`node:sqlite` with `setReturnArrays`); the repo as a whole asks for Node ≥ 24.15.

```bash
pnpm install --frozen-lockfile
pnpm run server -- info
pnpm run server -- migrate
pnpm run server -- login
```

`pnpm run server -- <command>` is the same entrypoint the container uses. Run the server's tests with `pnpm run test:server`.

---

## Commands

| Command                  | What it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `info`                   | Where the database is, its schema version, who is logged in |
| `migrate [--user=usr_…]` | Runs VRCX's own migration layer against the database        |
| `tables`                 | Row counts per table                                        |
| `query "SELECT …"`       | Read-only query, printed as positional rows                 |
| `login`                  | Logs in to VRChat, prompting for credentials and 2FA        |
| `whoami`                 | Shows the logged-in account                                 |
| `logout`                 | Clears the session (keeps saved credentials)                |
| `pipeline`               | Connects to the VRChat event pipeline and streams events    |
| `setup-totp`             | Sets the TOTP secret that protects `serve`'s HTTP/WS server  |
| `serve`                  | Starts the HTTP/WS server and the `updateLoop` daemon        |

Options: `--db=PATH`, `--user=ID`, `--create`, `--username=NAME`, `--endpoint=URL`, `--websocket=URL`, `--tls-cert=PATH`, `--tls-key=PATH`.

`--user` is only needed to create per-user tables for an account the database has never seen; `login` does it for you, and existing accounts are discovered through `sqlite_schema`.

`serve` requires a VRChat login to relay pipeline events over `/api/stream`, but not for `/api/rpc` — `database`/`configRepository` access works without one. It logs a warning and continues if there's no saved session, rather than refusing to start.

If `pnpm run prod-web` has been built (`build/html-web`), `serve` also serves it as the static web client at `/` — same-origin, so the browser never needs CORS. Without a build there, `serve` still works as an API-only server (`/api/*` and `/api/stream`).

Looking for the Electron desktop client instead? See [`client-desktop/README.md`](../client-desktop/README.md) for how to build and connect it to a `serve` instance.

## TOTP setup

`serve` is protected by a rotating 6-digit code from a standard 2FA app — not a static password. There's no default, and no backup/recovery codes, so pick whichever of these fits how you're setting it up.

### First time, via the browser (recommended)

Nothing to run up front. The moment `serve` starts with no secret configured yet, it logs a warning and starts anyway — opening the web client shows a QR code and the raw secret instead of a login form:

1. Scan the QR with any 2FA app (Bitwarden, Google Authenticator, 1Password, Authy, …) — or type the secret in by hand if your app doesn't scan.
2. Enter the current 6-digit code to confirm.
3. You're logged in immediately — no separate login step afterward.

This only works **once**. The instant a code is confirmed, the secret is saved, and the browser can never see it — or a new one — again: `/api/totp/setup`/`/api/totp/confirm` both refuse unconditionally from then on, logged in or not. There is no "regenerate" button anywhere in the UI, on purpose (see Resetting, below).

### First time, via the CLI

Useful before a web client is built, or for a fully non-interactive/scripted setup:

```bash
pnpm run server -- setup-totp
# or, in the container (needs -it — it's an interactive prompt):
docker run --rm -it -v ~/vrcx-data:/data ghcr.io/wentthefox/vrcx-headless-server:main setup-totp
```

Prints the secret and an `otpauth://` URI (most 2FA apps can import directly from the URI; paste the secret in by hand otherwise), then asks for the current code before saving anything — same confirm-before-persist behaviour as the browser flow.

`VRCX_SERVER_TOTP_SECRET` (below) skips enrollment entirely, if you'd rather generate a secret yourself and hand it to `serve` as a fixed environment variable.

### Resetting / rotating

Lost your 2FA device, or just want to re-pair? Run `setup-totp` again — **from the CLI only**, meaning shell access to the machine running `serve`. This is deliberate, not a missing feature: the browser is never trusted to reset TOTP on its own, even from an already-logged-in session, so a compromised browser tab alone can never lock you out or hand your account to someone else. `setup-totp` overwrites the existing secret unconditionally — there's no "are you sure", since running it at all already requires the access level that would make one meaningless.

If you've lost your 2FA device **and** don't have shell access either, there's no recovery — that's the tradeoff of no backup codes. The only way out is to clear the stored secret directly in the database with `serve` stopped:

```bash
sqlite3 ~/.config/VRCX/VRCX.sqlite3 "DELETE FROM configs WHERE name = 'VRCX_ServerTotpSecret'"
```

(The CLI's own `query` command can't do this — it opens the database read-only on purpose.) `serve`'s next start picks up the missing secret and falls back to first-time enrollment.

## Environment

| Variable               | Meaning                                                 |
| ----------------------- | -------------------------------------------------------- |
| `VRCX_DATABASE`        | Absolute path to `VRCX.sqlite3`                         |
| `VRCX_DATA_DIR`        | VRCX app data directory (`/data` in the container)      |
| `VRCX_LOG_LEVEL`       | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `VRCHAT_PASSWORD`      | Password for a non-interactive `login`                  |
| `VRCHAT_2FA_CODE`      | Two-factor code for a non-interactive `login`           |
| `VRCX_SERVER_TOTP_SECRET` | Base32 TOTP secret for `serve`, instead of running `setup-totp` |
| `VRCX_SERVER_HOST`     | HTTP/WS bind address (default `0.0.0.0`)                |
| `VRCX_SERVER_PORT`     | HTTP/WS bind port (default `9000`)                      |
| `VRCX_SERVER_TLS_CERT` | PEM certificate file, instead of `--tls-cert`           |
| `VRCX_SERVER_TLS_KEY`  | PEM private key file, instead of `--tls-key`            |
| `HTTPS_PROXY`          | Honoured when `NODE_USE_ENV_PROXY=1` (set in the image) |

---

## Using an existing VRCX install

The server resolves the database exactly the way the desktop app does, so it will find an existing install:

1. `VRCX_DATABASE`
2. `VRCX_DatabaseLocation` in `VRCX.json`
3. `<appdata>/VRCX/VRCX.sqlite3` — `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` (default `~/.config`) elsewhere

Cookies and saved credentials are stored in the same format the .NET app uses, so both can read the same file.

> **Back up `VRCX.sqlite3` before pointing the server at a real install**, and do not run the desktop app and the server against the same file at the same time. SQLite is in WAL mode and will not corrupt, but VRCX assumes it is the only writer.

`serve` and `pipeline` enforce this for **this fork's own processes**: each takes an exclusive lock (a `<database>.lock` PID file next to it) the moment it opens the database, and a second `serve`/`pipeline` against the same file refuses to start with a clear "already running (pid N)" error instead of racing the first one. `migrate` checks the same lock and refuses to run against a live `serve`/`pipeline` unless `--force` is passed — migrating out from under a live writer is the single riskiest way to corrupt the database. The lock releases automatically on a clean shutdown (Ctrl-C/SIGTERM) and is cleaned up automatically if a previous process crashed and left a stale one behind. This can't stop an old, unmodified desktop build from opening the same file directly — it has no idea this lockfile convention exists — which is exactly why the warning above still applies regardless.

## Security notes

- **VRChat credentials are stored the way upstream VRCX stores them.** With no primary password set, the password is saved in `savedCredentials` in **plaintext**, exactly as the desktop app does it. This is upstream behaviour, not something this fork introduced; treat `VRCX.sqlite3` as a secret.
- **`serve`'s own auth is TOTP, not a static password** (see "TOTP setup" above for setup/reset). A rotating 6-digit code from a 2FA app is worthless outside its 30-second window even if sniffed in transit — a real improvement over a static password given the common deployment is plain HTTP on a home network. The *secret* backing it is still the one long-lived credential (same threat model a password hash had), so `VRCX.sqlite3` remains something to treat as a secret either way.
- **`serve`'s cookie has no `Secure` flag by default.** The common deployment is a home-network Docker container over plain HTTP, so requiring TLS out of the box would just break that. Two ways to get TLS: put a reverse proxy in front, or point `serve` at a cert/key pair directly (`--tls-cert`/`--tls-key`, or `VRCX_SERVER_TLS_CERT`/`VRCX_SERVER_TLS_KEY`) — when either is used, the session cookie gains `Secure` automatically. `HttpOnly`/`SameSite=Strict` alone protect against XSS/CSRF, not eavesdropping on the wire, so exposing `serve` past a network you trust without one of these two is not safe.
- **Sessions are signed, stateless tokens (180-day expiry) that survive a `serve` restart.** Both clients call `/api/session/refresh` on every launch, which rotates a still-valid token into a fresh one with a full new expiry — so reopening the app within the window keeps sliding it forward, effectively "stay logged in indefinitely" as long as it's reopened at least once every 180 days. Nothing about that changes the trust model: treat a leaked session token as equivalent to a leaked TOTP code either way.
- **`/api/rpc` exposes `database`/`configRepository`'s full real method surface**, the same one the desktop app itself uses locally with no additional restriction — the authenticated session is the security boundary, not per-method filtering. Don't run `serve` on a database you wouldn't otherwise trust the network it's exposed to.
- The container runs as the non-root `node` user and writes only to `/data`.
