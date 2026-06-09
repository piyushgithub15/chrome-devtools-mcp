#!/bin/sh
# Production entrypoint for the cloud MCP deployment.
#
# Serves a streamable-HTTP MCP endpoint at  http://$HOST:$PORT/mcp  by wrapping a
# SINGLE long-lived chrome-devtools-mcp process with mcp-proxy. Because there is
# exactly one backing browser shared across all requests, page state persists
# across calls (navigate -> snapshot -> click) WITHOUT relying on an
# Mcp-Session-Id header — which the fronting on-demand proxy does not forward.
# This suits one-pod / low-concurrency use. (Per-session isolation for many
# concurrent users is a separate, session-manager design.)
#
# HEADFUL=1 runs headed Chrome on an Xvfb virtual display (real UA, fewer bot
# blocks). Unset/0 runs headless.
set -e

PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"

# Default headless launch flags.
CHROME_FLAGS="--headless"

case "${HEADFUL:-}" in
  1 | true | yes | TRUE | YES)
    export DISPLAY="${DISPLAY:-:99}"
    rm -f /tmp/.X99-lock
    echo "[entrypoint] HEADFUL=1 -> starting Xvfb on ${DISPLAY}"
    Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION:-1440x900x24}" -ac >/tmp/xvfb.log 2>&1 &
    sleep 1
    CHROME_FLAGS="--headless=false --chrome-arg=--disable-blink-features=AutomationControlled --ignore-default-chrome-arg=--enable-automation"
    ;;
  *)
    echo "[entrypoint] headless mode (set HEADFUL=1 to enable headed/Xvfb)"
    ;;
esac

echo "[entrypoint] starting mcp-proxy (single shared browser) on ${HOST}:${PORT}/mcp"

# Word-splitting of $CHROME_FLAGS is intentional (multiple flags, none contain spaces).
# shellcheck disable=SC2086
exec /app/node_modules/.bin/mcp-proxy \
  --port "$PORT" \
  --host "$HOST" \
  --server stream \
  --stateless \
  --connectionTimeout "${MCP_CONNECTION_TIMEOUT:-120000}" \
  --requestTimeout "${MCP_REQUEST_TIMEOUT:-3600000}" \
  -- \
  node /app/build/src/bin/chrome-devtools-mcp.js \
  $CHROME_FLAGS \
  --isolated \
  --executablePath=/usr/local/bin/chrome \
  --chrome-arg=--no-sandbox \
  --chrome-arg=--disable-setuid-sandbox \
  --chrome-arg=--disable-dev-shm-usage
