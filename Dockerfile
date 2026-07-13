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
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
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
