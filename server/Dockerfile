# Headless VRCX server.
#
# Build context is the REPO ROOT, not server/, because the image needs both
# `server/**` and the upstream data layer in `src/**`:
#   docker build -f server/Dockerfile -t vrcx-headless-server .
#
# Layout inside the image mirrors a dev checkout — /app/{node_modules,src,server}
# — so Node resolves `src/**`'s bare imports upward into /app/node_modules
# exactly as it does locally, and server/hooks.mjs derives repoRoot from its own
# location without any special casing. /app/build/html-web is the one addition
# to that layout — the built browser client (see the "web client" stage below),
# served by server/src/http-server.js at `/`.
#
# Dependencies come from server/package.json rather than the root manifest: the
# root keeps everything in devDependencies, so `pnpm install --prod` there
# installs nothing while a plain `pnpm install` would drag in electron and
# vite. See server/scripts/check-deps.js for the drift guard that keeps the
# two in step.

# ---- dependencies -----------------------------------------------------------
FROM node:24-alpine AS deps

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app
COPY server/package.json ./package.json
# pnpm-workspace.yaml, not just package.json — this is a standalone install
# (server/package.json has no lockfile of its own, always resolved fresh),
# so the minimumReleaseAge supply-chain policy only applies here if the
# config that defines it is actually present in this build context.
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml
# No lockfile for this manifest, and every dependency is pure JS, so there is
# nothing to compile and nothing arch-specific about this layer.
RUN pnpm install --prod --no-frozen-lockfile

# ---- web client ---------------------------------------------------------------
#
# Builds client-web/** (the browser client from phase 4) so `serve` has an
# actual UI to serve at `/` — without this, the server is API-only and every
# non-/api/* request 404s (found live: the container never bundled a built
# frontend at all). Discarded after the build; only its `build/html-web`
# output is copied into the runtime stage below, so none of this stage's
# devDependencies (vite, tailwind, vue-tsc, …) end up in the final image.
#
# This is the root package.json, not server/package.json — the frontend
# build needs vite/tailwind/vue, all upstream devDependencies the server
# itself has no use for (see the file-header comment on why the server has
# its own, much smaller, manifest).
#
# --platform=$BUILDPLATFORM: this stage's output (build/html-web/**) is
# static JS/CSS/HTML, identical regardless of which arch built it, so the
# multi-arch CI build (linux/amd64 + linux/arm64) should build it once on
# the real host arch rather than running it a second time under QEMU
# emulation for no reason — unlike the `deps` stage above, which stays
# unpinned since its output (node_modules) genuinely does end up in a
# specific target image and every dependency in it happens to be pure JS
# already, not because native output there would be safe to cross-copy.
FROM --platform=$BUILDPLATFORM node:24-alpine AS webclient

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# ELECTRON_SKIP_BINARY_DOWNLOAD, not --ignore-scripts: electron's own
# node_modules/electron/install.js checks this env var and exits
# immediately, skipping just its ~100MB platform binary download — more
# targeted than --ignore-scripts, which would also skip every *other*
# package's postinstall in this closure, including ones this stage's own
# build might actually depend on (e.g. a native binary some devDependency
# resolves via its own postinstall rather than an optionalDependency).
# pnpm-workspace.yaml's own allowBuilds list is what lets electron's
# postinstall run at all here in the first place (pnpm blocks it by
# default) — this env var just makes that approved run a no-op.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
# src/vite.config.js's PLATFORM=web branch still unconditionally imports
# client-desktop/aliases.js and server/vite-alias-plugin.js (→
# server/aliases.js) at module scope, even though neither's content is used
# for this platform — so all four of these need to be present, not just
# client-web/ and src/. It also unconditionally reads the repo-root
# Version file (for the compile-time VERSION define, real for every
# platform, not just Electron) — found by an actual CI build failing on
# exactly this ENOENT, not predicted.
COPY src ./src
COPY client-web ./client-web
COPY client-desktop ./client-desktop
COPY server ./server
COPY Version ./Version
# Three onboarding/nav components (src/components/onboarding/*.vue,
# src/components/nav-menu/NavMenu.vue) import the VRCX logo from the
# repo-root images/ directory via a relative `../../../images/VRCX.png` —
# also found by an actual CI build failing, not predicted.
COPY images ./images
# build-scripts/generate-third-party-licenses.js (pnpm run build:licenses,
# chained by prod-web below) is PLATFORM-aware as of this fork (see its own
# top-of-file comment): under PLATFORM=web it writes to build/html-web
# (matching vite's own outDir for this platform) and skips scanning
# Dotnet/** entirely, since none of that ships to a browser — so unlike an
# earlier version of this stage, Dotnet/** genuinely never needs to be in
# this build context at all.
COPY build-scripts ./build-scripts
RUN pnpm run prod-web

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

# CI computes this the same way server/src/globals.js's buildServerVersion()
# does (VRCX date, dots stripped, as the semver major) and passes it as a
# single --build-arg — see .github/workflows/server-docker.yaml and
# CLAUDE.md's "Server/Docker versioning". The default only applies to a
# manual `docker build` that didn't pass it — `... info` is the actual
# source of truth for a running container's own idea of this.
ARG SERVER_VERSION=0.0.0-unset

LABEL org.opencontainers.image.title="VRCX Headless Server"
LABEL org.opencontainers.image.description="Headless VRCX server: owns VRCX.sqlite3 and the VRChat API connection"
LABEL org.opencontainers.image.source="https://github.com/WentTheFox/VRCX-Headless"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${SERVER_VERSION}"

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server ./server
COPY src ./src
COPY Version ./Version
COPY --from=webclient /app/build/html-web ./build/html-web

# The database lives on a volume so it survives image upgrades. VRCX_DATA_DIR
# is resolved by server/src/paths.js the same way the desktop app resolves its
# app data directory.
ENV VRCX_DATA_DIR=/data
ENV NODE_ENV=production
# Lets Node's global fetch honour HTTPS_PROXY, replacing the proxy handling in
# Dotnet/WebApi.cs without taking an undici dependency.
ENV NODE_USE_ENV_PROXY=1

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
USER node

ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "--import", "./server/register-hooks.mjs", "server/src/cli.js"]
CMD ["info"]
