# syntax=docker/dockerfile:1
# Build (required on Apple Silicon): docker build --platform linux/amd64 -t chrome-devtools-mcp:local .

FROM node:24-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./

ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN npm ci --ignore-scripts

COPY . .

ENV NODE_OPTIONS=--max_old_space_size=4096

RUN node scripts/prepare.ts

RUN npm run bundle

FROM node:24-bookworm AS runtime

WORKDIR /app

COPY package.json package-lock.json .npmrc ./

RUN npm ci --ignore-scripts \
    && npm install mcp-proxy@6.5.1 redis@5.12.1 @modelcontextprotocol/sdk@1.29.0 --no-save \
    && npm cache clean --force

ENV NODE_ENV=production \
    CI=true \
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=build /app/build ./build
COPY --from=build /app/LICENSE ./LICENSE
COPY scripts/goose-http-entrypoint.mjs /app/scripts/

# Install "Chrome for Testing" into the Puppeteer cache and expose it at a
# fixed path. Xvfb is included so the server can run Chrome HEADFUL (HEADFUL=1)
# on a virtual display. Use: docker build --platform linux/amd64 ...
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb \
    && npx puppeteer browsers install chrome --install-deps \
    && CHROME_BIN="$(find /root/.cache/puppeteer/chrome -path '*/chrome-linux64/chrome' -type f | head -n 1)" \
    && test -n "$CHROME_BIN" && test -x "$CHROME_BIN" \
    && ln -sf "$CHROME_BIN" /usr/local/bin/chrome \
    && /usr/local/bin/chrome --version \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/goose-http-entrypoint-xvfb.sh /app/scripts/
RUN chmod +x /app/scripts/goose-http-entrypoint-xvfb.sh

EXPOSE 8080

# Goose: http://<host>:8080/mcp?redis_channel=<messageId>_chrome_mcp
# Set HEADFUL=1 to run headed Chrome on Xvfb (real UA, fewer bot blocks).
ENTRYPOINT ["/app/scripts/goose-http-entrypoint-xvfb.sh"]
