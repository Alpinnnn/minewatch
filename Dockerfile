# =============================================================================
# MineWatch - multi-stage Dockerfile
# Builder stage:  full node image with dev deps to compile TypeScript.
# Runtime stage: node:20-alpine (linux/musl) with only prod deps + compiled JS.
# =============================================================================

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /app

# `git` is needed because some npm packages (including recent
# @whiskeysockets/baileys versions and their transitive deps) run
# `git` in their install / prepare lifecycle scripts.  node:20-alpine
# does not ship git by default.  Keep the layer size minimal with
# --no-cache.
RUN apk add --no-cache git

# Install ALL deps (including dev) for the build.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Trim dev deps to ship only the runtime tree to the final stage.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as a non-root user for least-privilege.  Alpine ships `node` user
# out of the box on the official node images.
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    WHATSAPP_AUTH_DIR=/app/auth_info

# Copy only what we need to run.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Persistent auth dir (mounted as a volume in compose).
RUN mkdir -p /app/auth_info && chown -R node:node /app
USER node

# No exposed ports - the daemon is a pure outbound client.
# Health is verified by the docker-compose `healthcheck` running
# a tiny inline command that exits 0 only if the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD pgrep -f "node dist/index.js" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
