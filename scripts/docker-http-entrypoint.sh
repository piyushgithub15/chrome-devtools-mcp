#!/bin/sh
set -e

PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"

exec /app/node_modules/.bin/mcp-proxy \
  --port "$PORT" \
  --host "$HOST" \
  --server stream \
  --stateless \
  --connectionTimeout "${MCP_CONNECTION_TIMEOUT:-120000}" \
  --requestTimeout "${MCP_REQUEST_TIMEOUT:-600000}" \
  -- \
  node /app/build/src/bin/chrome-devtools-mcp.js \
  --headless \
  --isolated \
  --executablePath=/usr/local/bin/chrome \
  --chrome-arg=--no-sandbox \
  --chrome-arg=--disable-setuid-sandbox \
  --chrome-arg=--disable-dev-shm-usage \
  "$@"
