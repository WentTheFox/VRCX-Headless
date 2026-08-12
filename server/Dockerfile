# Headless VRCX server.
#
# Build context is the REPO ROOT, not server/, because the image needs both
# `server/**` and the upstream data layer in `src/**`:
#   docker build -f server/Dockerfile -t vrcx-headless-server .
#
# Layout inside the image mirrors a dev checkout — /app/{node_modules,src,server}
# — so Node resolves `src/**`'s bare imports upward into /app/node_modules
# exactly as it does locally, and server/hooks.mjs derives repoRoot from its own
# location without any special casing.
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

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

LABEL org.opencontainers.image.title="VRCX Headless Server"
LABEL org.opencontainers.image.description="Headless VRCX server: owns VRCX.sqlite3 and the VRChat API connection"
LABEL org.opencontainers.image.source="https://github.com/WentTheFox/VRCX-Headless"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server ./server
COPY src ./src
COPY Version ./Version

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
