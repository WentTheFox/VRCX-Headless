# VRCX Headless Server

The headless half of [VRCX-Headless](https://github.com/WentTheFox/VRCX-Headless): a Node process that owns `VRCX.sqlite3` and the VRChat API connection, so the UI can run in a browser or on several devices at once without racing on the database.

It runs VRCX's **real** data layer — `src/services/database/**` and `src/services/config.js` are imported unmodified — so it stays in step with upstream instead of forking it. See [`CLAUDE.md`](../CLAUDE.md) for how that works and what the rules are.

> **Status: phase 2a.** The server owns the database and the VRChat connection (login, cookies, pipeline). It does not yet run the background stores or serve clients over HTTP — that is phases 2b and 3. Today it is a CLI, not a daemon.

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

Options: `--db=PATH`, `--user=ID`, `--create`, `--username=NAME`, `--endpoint=URL`, `--websocket=URL`.

`--user` is only needed to create per-user tables for an account the database has never seen; `login` does it for you, and existing accounts are discovered through `sqlite_schema`.

## Environment

| Variable          | Meaning                                                 |
| ----------------- | ------------------------------------------------------- |
| `VRCX_DATABASE`   | Absolute path to `VRCX.sqlite3`                         |
| `VRCX_DATA_DIR`   | VRCX app data directory (`/data` in the container)      |
| `VRCX_LOG_LEVEL`  | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `VRCHAT_PASSWORD` | Password for a non-interactive `login`                  |
| `VRCHAT_2FA_CODE` | Two-factor code for a non-interactive `login`           |
| `HTTPS_PROXY`     | Honoured when `NODE_USE_ENV_PROXY=1` (set in the image) |

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
- The server has **no authentication and no network listener** yet — it is a CLI. Password-protected HTTP access arrives in phase 3; do not expose the data directory or the eventual port to an untrusted network before then.
- The container runs as the non-root `node` user and writes only to `/data`.
