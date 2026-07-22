# Shiba Studio — production image.
#
#   docker build -t shiba-studio .
#   docker run -p 127.0.0.1:3000:3000 -v shiba-data:/data shiba-studio
#
# Publish the port on 127.0.0.1 (as above) to keep the studio loopback-only,
# matching the app's security model. The /data volume holds ALL state —
# config, encrypted credentials, the encryption key, runs, chats, and the
# official xurl bridge's per-app X OAuth cache under /data/x-mcp/*/.xurl.
# Browser-automation tools are disabled in the image (no Chromium) — run from
# source if you need the sub-browser/annotation features.

# Supply the source revision when building outside a Git checkout (CI and
# Docker Compose do this explicitly). The runtime API reads SHIBA_GIT_COMMIT,
# while the OCI labels make the same revision inspectable without starting the
# container.
ARG SHIBA_GIT_COMMIT=unreleased
ARG SHIBA_IMAGE_SOURCE=https://github.com/stevologic/shiba-studio

FROM node:24-bookworm-slim AS build
WORKDIR /app
# node-pty compiles from source; Chromium is skipped (see note above).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ARG SHIBA_GIT_COMMIT
ARG SHIBA_IMAGE_SOURCE
LABEL org.opencontainers.image.title="Shiba Studio" \
      org.opencontainers.image.description="Local-first Grok agent studio" \
      org.opencontainers.image.source="${SHIBA_IMAGE_SOURCE}" \
      org.opencontainers.image.revision="${SHIBA_GIT_COMMIT}" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    SHIBA_GIT_COMMIT=${SHIBA_GIT_COMMIT} \
    SHIBA_DATA_DIR=/data \
    SHIBA_SECRET_KEY_FILE=/data/shiba-studio.key \
    SHIBA_PROJECT_ROOT=/app \
    HOME=/data/home \
    PORT=3000
COPY --from=build /app ./
EXPOSE 3000
VOLUME /data
# 0.0.0.0 inside the container; the host-side publish decides real exposure.
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
