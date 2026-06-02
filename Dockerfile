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

ENV NODE_ENV=production \
    CI=true \
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PORT=8080 \
    HOST=0.0.0.0

COPY package.json package-lock.json .npmrc ./

RUN npm ci --ignore-scripts \
    && npm install mcp-proxy@6.5.1 --no-save \
    && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/LICENSE ./LICENSE
COPY scripts/docker-http-entrypoint.sh /usr/local/bin/docker-http-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-http-entrypoint.sh

# Install "Chrome for Testing" into the Puppeteer cache and expose it at a
# fixed path. Use: docker build --platform linux/amd64 ...
RUN apt-get update \
    && npx puppeteer browsers install chrome --install-deps \
    && CHROME_BIN="$(find /root/.cache/puppeteer/chrome -path '*/chrome-linux64/chrome' -type f | head -n 1)" \
    && test -n "$CHROME_BIN" && test -x "$CHROME_BIN" \
    && ln -sf "$CHROME_BIN" /usr/local/bin/chrome \
    && /usr/local/bin/chrome --version \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8080

# Streamable HTTP at http://<host>:8080/mcp (stateless; new MCP+Chrome per session).
ENTRYPOINT ["docker-http-entrypoint.sh"]
