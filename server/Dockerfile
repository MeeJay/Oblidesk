# ---- Build stage (shared + server) ----
FROM node:24-alpine AS builder
WORKDIR /app

# The shared package must be COMPILED before the server: the server resolves
# @oblidesk/shared through the npm-workspace symlink to shared/dist, not to source.
COPY package.json ./
COPY shared/ ./shared/
RUN cd shared && npm install && npm run build

COPY server/package.json ./server/
RUN cd server && npm install

COPY server/tsconfig.json server/knexfile.ts ./server/
COPY server/src/ ./server/src/
RUN cd server && npm run build

# ---- Production stage ----
FROM node:24-alpine AS production
WORKDIR /app

COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/shared/dist/ ./shared/dist/

COPY --from=builder /app/server/package.json ./server/
COPY package.json ./
RUN cd server && npm install --omit=dev

COPY --from=builder /app/server/dist/ ./server/dist/

# Attachment blob store. Bind-mounted in production (CUSTOM_DIR -> /custom);
# created here so the server can start even without a mount (dev / smoke test).
RUN mkdir -p /custom/attachments

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD sh -c "wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/health || exit 1"

WORKDIR /app/server
# Migrations run at boot from src/index.ts (knex.migrate.latest) - no entrypoint script.
CMD ["node", "dist/src/index.js"]
