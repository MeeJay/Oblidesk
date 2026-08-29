# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app

# Root package.json for workspace resolution
COPY package.json ./

# Shared SOURCE (the Vite alias @oblidesk/shared points at ../shared/src).
# Its package.json is also needed for workspace linking.
COPY shared/ ./shared/

# Install client dependencies via the workspace
COPY client/package.json ./client/
RUN npm install --workspace=client

# Build client (copy remaining source)
COPY client/ ./client/
RUN cd client && npm run build

# ---- Production stage ----
FROM nginx:alpine AS production

# curl is more reliable than busybox wget for healthchecks
RUN apk add --no-cache curl

COPY --from=builder /app/client/dist/ /usr/share/nginx/html/
COPY client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# -s silent, -f fail on HTTP errors (4xx/5xx -> exit 1), -o discard body
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -sf http://localhost/ -o /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
