<div align="center">

# <img src="https://raw.githubusercontent.com/vrcx-team/VRCX/master/images/VRCX.ico" width="64" height="64"> </img> VRCX-Headless

[![GitHub release](https://img.shields.io/github/release/WentTheFox/VRCX-Headless.svg)](https://github.com/WentTheFox/VRCX-Headless/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/WentTheFox/VRCX-Headless/total?color=6451f1)](https://github.com/WentTheFox/VRCX-Headless/releases/latest)
[![CI](https://github.com/WentTheFox/VRCX-Headless/actions/workflows/ci.yaml/badge.svg)](https://github.com/WentTheFox/VRCX-Headless/actions/workflows/ci.yaml)

</div>

**VRCX-Headless** is a fork of [VRCX](https://github.com/vrcx-team/VRCX) that splits the app into a headless server and a client. The server owns `VRCX.sqlite3` and the VRChat API connection; the client is the same Vue app VRCX has always shipped, running either in the desktop shell or a browser, so you can see the same data in sync across several devices instead of one machine holding the only copy.

- **Server setup, Docker images and CLI reference → [`server/README.md`](./server/README.md)** (multi-arch, runs on a Raspberry Pi)
- **Building and running the Electron desktop client → [`client-desktop/README.md`](./client-desktop/README.md)**
- **Architecture, fork invariants and the upstream merge procedure → [`CLAUDE.md`](./CLAUDE.md)**

## What this fork adds

Everything here is on top of upstream VRCX, which keeps working as before. This lists new user-facing features only, not fixes for things the fork itself broke or upstream behaviour it preserved; the technical details live in [`CLAUDE.md`](./CLAUDE.md) and [`docs/patch-inventory.md`](./docs/patch-inventory.md).

### Architecture

- **Headless server** (Node, Docker, multi-arch incl. Raspberry Pi). It owns the VRChat login, the pipeline WebSocket, the polling loop and `VRCX.sqlite3`, and is the only writer of the database. One instance runs 24/7, so nothing is missed while your PC is off.
- **Browser client** (`PLATFORM=web`): the same Vue UI, served from any device, kept in sync with the server over an event stream. Settings are shared across devices.
- **Electron desktop client** for Linux and Windows, connecting to your server. A .NET sidecar provides the machine-local parts: game log tailing, VR overlay, Discord Rich Presence, registry access, screenshots and game launch. The CefSharp client is gone.
- **TOTP login** for the server, with first-time enrollment from the browser or CLI.
- **Multiple servers** on the desktop client: a server switcher, a remembered default and a setup screen.
- **Reuses your existing database.** The server runs upstream's own data layer unchanged, so a desktop VRCX `VRCX.sqlite3` can be moved over (see [`server/README.md`](./server/README.md)).

### Server features

- **Local read-only API (optional, off by default).** Let your own tools (a stream overlay, a Discord bot, a personal site) read your VRChat data straight from the server's local cache, without needing a VRChat login of their own. Enable it with `VRCX_API_ENABLED=1`; until then it doesn't exist, and `/api/v1/*` returns 404.
  - Scoped, expiring API keys (`profile:read`, `playtime:read`, `users:read`, `friends:read`, `notes:read`), shown once and revocable instantly.
  - Endpoints for your profile, time spent together (single and batch), user lookups, your friends list, notes and Discord ids, with an OpenAPI spec at `/api/v1/openapi.json`.
  - Strictly read-only. Keys can't reach the web client, the RPC channel or key management, and the API can optionally run on its own separate port so none of that is exposed.
  - Key management page, embedded in the web and desktop status bar. See [`docs/external-api.md`](./docs/external-api.md).
- **Server CLI** for logging in, inspecting and querying the database, running migrations and maintenance tasks, and starting the server. See [Commands in `server/README.md`](./server/README.md#commands).
- **Seen-avatars index** (`seen_avatars`), shown on a user's Avatars tab ahead of the external avatar database.
- **avtrDB lookups** done server-side with a compliant User-Agent (`AVTRDB_CONTACT`), with readable errors when the provider blocks a request.
- **Game log as a second notification source**, so notifications still arrive when the VRChat pipeline is down.
- **Automatic VRChat settings backup**, stored server-side.
- **Fork update checker**: Settings shows the upstream VRCX version the fork is based on, and the repository to update from is configurable.

### Desktop client features

- **Self-updater** for Windows (installer) and Linux (AppImage) with hash verification and a startup splash, driven by this fork's GitHub releases.
- **Cross-platform release pipeline**: Windows (x64/arm64) and Linux (x64/arm64) builds, plus Docker images, tagged `<vrcx-date>.<minor>.<patch>`.
- **Windows support in the Electron client**: game launch, native registry backup/restore, clipboard, "open folder", open-instance-in-running-VRChat, auto-launch of helper apps with VRChat, and a SteamVR VR overlay.
- **Linux support**: autostart `.desktop` entry, open instances in a running VRChat under Wine/Proton, VR overlay via OpenGL, Steam path autodetection.
- **Start with SteamVR** option.
- **Persistent invite notifications** that stay on screen until dismissed while the game is closed.
- **Customizable tray and in-app notification dot colors** per notification type.

### UI and behaviour changes

- Headless server status indicator in the status bar.
- Option to show a friend's status instead of "Private" in the sidebar.
- DeepL as a third bio translation provider.

Everything below is upstream VRCX's own documentation and still describes the desktop app.

<div align="center">

# <img src="https://raw.githubusercontent.com/vrcx-team/VRCX/master/images/VRCX.ico" width="64" height="64"> </img> VRCX

[![GitHub release](https://img.shields.io/github/release/vrcx-team/VRCX.svg)](https://github.com/vrcx-team/VRCX/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/vrcx-team/VRCX/total?color=6451f1)](https://github.com/vrcx-team/VRCX/releases/latest)
[![GitHub Workflow Status](https://github.com/vrcx-team/VRCX/actions/workflows/github_actions.yml/badge.svg)](https://github.com/vrcx-team/VRCX/actions/workflows/github_actions.yml)
[![VRCX Discord Invite](https://img.shields.io/discord/854071236363550763?color=%237289DA&logo=discord&logoColor=white&label=discord)](https://vrcx.app/discord)

| **English** | [Français](./README/README.fr.md) | [日本語](./README/README.jp.md) | [简体中文](./README/README.zh_CN.md) | [Italiano](./README/README.it.md) | [Русский](./README/README.ru_RU.md) | [Español](./README/README.es.md) | [Polski](./README/README.pl.md) | [ภาษาไทย](./README/README.th.md) | [Magyar](./README/README.hu.md)

VRCX is an assistant/companion application for VRChat that provides information about and helps you accomplish various things related to VRChat in a more convenient fashion than relying on the plain VRChat client (desktop or VR), or website alone. It also includes some other neat features outlined below.

<div align="center">

# Getting Started

<div align="center">

Download and install the latest installer (`VRCX_Setup.exe`) from [here](https://github.com/vrcx-team/VRCX/releases/latest).

For macOS and Linux check [here](https://github.com/vrcx-team/VRCX/wiki/Running-VRCX-on-Linux) for more info.

Beta/nightly build available [here](https://vrcx.app/github/nightly) or in-app `Settings -> General -> Change build`.

# Features

<div align="left">

- :family: Friend, world, and avatar list management
  - Manage your friends list, world/group/avatar lists outside of VRChat.
  - Monitor the activity of your friends and track their online status, locations, and avatars.
  - Track friendship history including add dates, time spent together, and name changes.
  - Save notes and memos to help remember how you met.
- :bar_chart: Customizable Dashboard with widgets
  - Build personalized multi-panel layouts with Feed, GameLog, and Instance widgets.
  - Create multiple dashboards, each with configurable event filters and column visibility.
- :mag: Powerful search across all entities
  - Search for users, worlds, avatars, and groups, or paste IDs and URLs for direct access.
  - Quick Search provides instant client-side fuzzy search across your friends, avatars, worlds, and groups.
- :chart_with_upwards_trend: Activity Heatmap
  - Visualize a user's online activity patterns with a day-of-week × hour-of-day heatmap, including peak stats.
- :camera: Store world data in the pictures you take in-game, so you can remember that one world you took those cool pictures in like... 6 months ago!
- :bell: Monitor/respond to notifications
  - You can send/receive invites and friend requests from VRCX as well as see the instance info of invites that you receive.
- :scroll: See stats/players for your current instance
- :tv: See the links to videos that are playing in the world you're in, as well as various other logged data.
- :performing_arts: Social Status Presets
  - Save and quickly apply status + status description combinations from the sidebar or user dialog.
- :rotating_light: VRChat Server Status
  - A status bar indicator and login page alert inform you of VRChat server issues and outages in real time.
- :bar_chart: Improved Discord Rich Presence
  - Display detailed instance information in Discord, including world thumbnail, name, player count, and a join button for public lobbies.
- :crystal_ball: VR Overlay with configurable live feed of all supported events/notifications
- :outbox_tray: Upload and manage avatar/world images and details without Unity
- :electric_plug: Automatically launch apps when you start VRChat
- :skull: Automatically restart and join last instance when VRC crashes
- :left_right_arrow: Export/import data
  - Export friends list, avatar list, Discord names, notes, and favorite groups. Import favorite groups and group moderation bans.

## Miscellaneous

- Want a new look for VRCX? Check out [Themes](https://github.com/vrcx-team/VRCX/wiki/Themes)
- See [Building from source](https://github.com/vrcx-team/VRCX/wiki/Building-from-source) for instructions on how to build VRCX from source.
- For a guide on how to run VRCX on Linux, see [here](https://github.com/vrcx-team/VRCX/wiki/Running-VRCX-on-Linux)
- Interested in contributing? See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines.

# Screenshots

<div align="center">

<h3>Login</h3>

<table>
  <tr>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251994190-5e6a961e-b2fe-4d3b-bf66-455d8626b8bf.png" alt="login"></td>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251994414-a21faf59-6199-45de-94e7-a093a6b8c0ac.png" alt="2fa"></td>
  </tr>
</table>

<h3>Feed</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251987020-9839a2c9-47db-4271-b1bf-8e07669a7056.png" alt="feed">

<h3>GameLog</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251987498-b82266ed-131d-42ad-be2f-b167f24acf9f.png" alt="gamelog">

<h3>UserInfo</h3>

<h4>Me</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251990237-0c863d27-141c-4447-82de-4279ab8973ea.png" alt="me">

<h4>Friend</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251989666-8f918786-e632-451d-be29-f92d2c681b80.png" alt="friend">

<h3>World</h3>

<table>
  <tr>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251991003-37a986bb-470c-442b-8ada-31918f7b2017.png" alt="instance"></td>
    <td align="center"><img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251991217-0d40846f-ac08-48c0-8e4d-18c35fe0999b.png" alt="info"></td>
  </tr>
</table>

<h3>Favorite</h3>

<h4>Friend</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251992424-ba406d0f-787e-4e2d-89bd-4caa0a05d31f.png" alt="friend">

<h4>World</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251992950-8f2c6cdc-dc9a-4a60-b59f-9fa80d071359.png" alt="world">

<h4>Avatar</h4>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251993408-66d11100-15a8-484f-b9fd-82be1516c9be.png" alt="avatar">

<h3>Friend Log</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251993741-e2033095-4ceb-4552-8b79-9285325c1e49.png" alt="friendlog">

<h3>Discord Rich Presence</h3>

<img src="https://github-production-user-asset-6210df.s3.amazonaws.com/82102170/251997318-5a71249c-59fc-4ad6-9194-d6b1d4165600.png" alt="discord">

<!-- The other images will be similar to this -->
</div>

## Is VRCX against VRChat's TOS?

**No.**

VRCX is an external tool that uses the VRChat API to provide the features it does.

It does not modify the game in any way, only using the API responsibly to provide the features it does. It is not a mod, or a cheat, or any other form of modification to the game.

To see VRChat's stance on API usage, see the #faq channel in the VRChat Discord.

---

VRCX is not endorsed by VRChat and does not reflect the views or opinions of VRChat or anyone officially involved in producing or managing VRChat properties. VRChat and all associated properties are trademarks or registered trademarks of VRChat Inc. VRChat © VRChat Inc.
