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
# root keeps everything in devDependencies, so `--omit=dev` there installs
# nothing while `--include=dev` would drag in electron and vite. See
# server/scripts/check-deps.js for the drift guard that keeps the two in step.

# ---- dependencies -----------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app
COPY server/package.json ./package.json
# No package-lock for this manifest, and every dependency is pure JS, so there
# is nothing to compile and nothing arch-specific about this layer.
RUN npm install --omit=dev --no-audit --no-fund

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

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: this stage only ever runs `vite build`, never electron
# itself, so there is no reason to pay for electron's own postinstall (a
# full platform binary download) just to discard the whole stage afterwards.
RUN npm ci --ignore-scripts --no-audit --no-fund
# src/vite.config.js's PLATFORM=web branch still unconditionally imports
# client-desktop/aliases.js and server/vite-alias-plugin.js (→
# server/aliases.js) at module scope, even though neither's content is used
# for this platform — so all four of these need to be present, not just
# client-web/ and src/.
COPY src ./src
COPY client-web ./client-web
COPY client-desktop ./client-desktop
COPY server ./server
# build-scripts/generate-third-party-licenses.js (npm run build:licenses,
# chained by prod-web below) is PLATFORM-aware as of this fork (see its own
# top-of-file comment): under PLATFORM=web it writes to build/html-web
# (matching vite's own outDir for this platform) and skips scanning
# Dotnet/** entirely, since none of that ships to a browser — so unlike an
# earlier version of this stage, Dotnet/** genuinely never needs to be in
# this build context at all.
COPY build-scripts ./build-scripts
RUN npm run prod-web

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

# CI passes both as --build-arg, read from server/VERSION and the repo-root
# Version file respectively (see .github/workflows/server-docker.yaml and
# CLAUDE.md's "Server/Docker versioning"). Defaults only apply to a manual
# `docker build` that didn't pass them — server/src/cli.js's `info` command
# is the actual source of truth for a running container's own idea of this.
ARG FORK_VERSION=0.0.0-unset
ARG VRCX_VERSION=unknown

LABEL org.opencontainers.image.title="VRCX Headless Server"
LABEL org.opencontainers.image.description="Headless VRCX server: owns VRCX.sqlite3 and the VRChat API connection"
LABEL org.opencontainers.image.source="https://github.com/WentTheFox/VRCX-Headless"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${FORK_VERSION}+vrcx.${VRCX_VERSION}"

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
