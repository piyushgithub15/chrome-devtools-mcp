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
#
# PROXY_SERVER routes Chrome traffic through a proxy (e.g. a residential proxy)
# to get a non-datacenter IP. Needed for sites that edge-block datacenter IPs
# (e.g. MakeMyTrip served a blank "200-OK" stub from a cloud IP).
#
# Accepted formats (all equivalent):
#   http://user:pass@host:port   — HTTP proxy with credentials
#   socks5://user:pass@host:port — SOCKS5 proxy with credentials
#   host:port                    — proxy without credentials (or IP-whitelisted)
#
# Chrome's --proxy-server does NOT support inline credentials; this script
# parses them out and passes them via --proxy-username / --proxy-password so
# that Puppeteer's page.authenticate() can handle 407 challenges automatically.
set -e

PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"

# Default headless launch flags.
CHROME_FLAGS="--headless"

# Optional proxy (residential IP) for anti-bot-heavy sites.
PROXY_ARG=""
PROXY_AUTH_ARGS=""
if [ -n "${PROXY_SERVER:-}" ]; then
  # Extract host:port only (strip scheme and credentials).
  # Chrome's --proxy-server is strict: it wants "host:port" or "socks5://host:port",
  # NOT "http://user:pass@host:port/". Strip everything but host:port.
  # e.g. "http://user:pass@1.2.3.4:1234/"  -> "1.2.3.4:1234"
  #      "socks5://user:pass@1.2.3.4:1234" -> "socks5://1.2.3.4:1234"
  #      "1.2.3.4:1234"                    -> "1.2.3.4:1234"
  _SCHEME="$(printf '%s' "${PROXY_SERVER}" | sed -n 's|^\([a-z0-9+]*\)://.*|\1|p')"
  _HOSTPORT="$(printf '%s' "${PROXY_SERVER}" | sed 's|^[a-z0-9+]*://[^@]*@||; s|^[a-z0-9+]*://||; s|[/]*$||')"
  # For SOCKS5 preserve the scheme prefix; for http/https just use host:port.
  case "${_SCHEME}" in
    socks5|socks4) PROXY_HOSTPORT="${_SCHEME}://${_HOSTPORT}" ;;
    *)             PROXY_HOSTPORT="${_HOSTPORT}" ;;
  esac
  # Extract credentials: "user:pass" or empty.
  PROXY_CREDS="$(printf '%s' "${PROXY_SERVER}" | sed -n 's|^[a-z0-9+]*://\([^@]*\)@.*|\1|p')"

  echo "[entrypoint] routing Chrome through proxy: ${PROXY_HOSTPORT}"
  PROXY_ARG="--proxy-server=${PROXY_HOSTPORT}"   # dedicated CLI option, not --chrome-arg

  if [ -n "${PROXY_CREDS}" ]; then
    PROXY_USER="$(printf '%s' "${PROXY_CREDS}" | cut -d: -f1)"
    PROXY_PASS="$(printf '%s' "${PROXY_CREDS}" | cut -d: -f2-)"
    echo "[entrypoint] proxy credentials present for user: ${PROXY_USER}"
    PROXY_AUTH_ARGS="--proxy-username=${PROXY_USER} --proxy-password=${PROXY_PASS}"
  fi
fi

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

# Word-splitting of $CHROME_FLAGS / $PROXY_ARG / $PROXY_AUTH_ARGS is intentional
# (multiple flags; none contain spaces).
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
  $PROXY_ARG \
  $PROXY_AUTH_ARGS \
  --isolated \
  --executablePath=/usr/local/bin/chrome \
  --chrome-arg=--no-sandbox \
  --chrome-arg=--disable-setuid-sandbox \
  --chrome-arg=--disable-dev-shm-usage
