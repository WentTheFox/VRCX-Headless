# VRCX Headless Server

The headless half of [VRCX-Headless](https://github.com/WentTheFox/VRCX-Headless): a Node process that owns `VRCX.sqlite3` and the VRChat API connection, so the UI can run in a browser or on several devices at once without racing on the database.

It runs VRCX's **real** data layer — `src/services/database/**` and `src/services/config.js` are imported unmodified — so it stays in step with upstream instead of forking it. See [`CLAUDE.md`](../CLAUDE.md) for how that works and what the rules are.

> **Status: phase 3.** The server owns the database and the VRChat connection, runs the real background stores and the `updateLoop` daemon, and now serves an authenticated HTTP/WS API too (`serve`) — password auth, a generic `/api/rpc` dispatcher over `database`/`configRepository`, and `/api/stream` relaying the VRChat pipeline verbatim. There's no web client yet to talk to it (phase 4).

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
        environment:
            VRCX_LOG_LEVEL: info
        # Phase 2a has no long-running service yet; `pipeline` is the closest
        # thing. Phase 3 replaces this with `serve`.
        command: pipeline
        restart: unless-stopped
```

### Tags

| Tag             | What it is                         |
| --------------- | ---------------------------------- |
| `main`          | latest build of the default branch |
| `sha-<short>`   | a specific commit                  |
| `v1.2.3`, `1.2` | released versions                  |
| `latest`        | most recent release tag            |

---

## Running from a checkout

Requires Node ≥ 22.5 for the server itself (`node:sqlite` with `setReturnArrays`); the repo as a whole asks for Node ≥ 24.15.

```bash
npm ci
npm run server -- info
npm run server -- migrate
npm run server -- login
```

`npm run server -- <command>` is the same entrypoint the container uses. Run the server's tests with `npm run test:server`.

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
| `set-password`           | Sets the password that protects `serve`'s HTTP/WS server    |
| `serve`                  | Starts the HTTP/WS server and the `updateLoop` daemon        |

Options: `--db=PATH`, `--user=ID`, `--create`, `--username=NAME`, `--endpoint=URL`, `--websocket=URL`.

`--user` is only needed to create per-user tables for an account the database has never seen; `login` does it for you, and existing accounts are discovered through `sqlite_schema`.

`serve` requires a VRChat login to relay pipeline events over `/api/stream`, but not for `/api/rpc` — `database`/`configRepository` access works without one. It logs a warning and continues if there's no saved session, rather than refusing to start.

## Environment

| Variable               | Meaning                                                 |
| ----------------------- | -------------------------------------------------------- |
| `VRCX_DATABASE`        | Absolute path to `VRCX.sqlite3`                         |
| `VRCX_DATA_DIR`        | VRCX app data directory (`/data` in the container)      |
| `VRCX_LOG_LEVEL`       | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `VRCHAT_PASSWORD`      | Password for a non-interactive `login`                  |
| `VRCHAT_2FA_CODE`      | Two-factor code for a non-interactive `login`           |
| `VRCX_SERVER_PASSWORD` | Password for `serve`, instead of running `set-password` |
| `VRCX_SERVER_HOST`     | HTTP/WS bind address (default `0.0.0.0`)                |
| `VRCX_SERVER_PORT`     | HTTP/WS bind port (default `9000`)                      |
| `HTTPS_PROXY`          | Honoured when `NODE_USE_ENV_PROXY=1` (set in the image) |

---

## Using an existing VRCX install

The server resolves the database exactly the way the desktop app does, so it will find an existing install:

1. `VRCX_DATABASE`
2. `VRCX_DatabaseLocation` in `VRCX.json`
3. `<appdata>/VRCX/VRCX.sqlite3` — `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` (default `~/.config`) elsewhere

Cookies and saved credentials are stored in the same format the .NET app uses, so both can read the same file.

> **Back up `VRCX.sqlite3` before pointing the server at a real install**, and do not run the desktop app and the server against the same file at the same time. SQLite is in WAL mode and will not corrupt, but VRCX assumes it is the only writer, and enforcing that is phase 6.

## Security notes

- **VRChat credentials are stored the way upstream VRCX stores them.** With no primary password set, the password is saved in `savedCredentials` in **plaintext**, exactly as the desktop app does it. This is upstream behaviour, not something this fork introduced; treat `VRCX.sqlite3` as a secret.
- **`serve`'s cookie has no `Secure` flag by default.** The common deployment is a home-network Docker container over plain HTTP, so requiring TLS out of the box would just break that. Put a reverse proxy with TLS in front before exposing `serve` past a network you trust — `HttpOnly`/`SameSite=Strict` protect against XSS/CSRF, not eavesdropping on the wire.
- **Sessions are process-lifetime only.** They live in memory, not the database; restarting `serve` signs everyone out. There's no rotation or expiry yet either — treat a leaked session cookie as equivalent to a leaked password until that lands.
- **`/api/rpc` exposes `database`/`configRepository`'s full real method surface**, the same one the desktop app itself uses locally with no additional restriction — the authenticated session is the security boundary, not per-method filtering. Don't run `serve` on a database you wouldn't otherwise trust the network it's exposed to.
- The container runs as the non-root `node` user and writes only to `/data`.
