#!/bin/sh
# Production entrypoint that optionally runs Chrome HEADFUL on a virtual display.
#
# HEADFUL=1  -> start an Xvfb virtual display and run headed Chrome (real UA,
#               avoids the "HeadlessChrome" signal that anti-bot services block).
# unset/0    -> behaves like the original headless entrypoint.
#
# In both cases it execs scripts/goose-http-entrypoint.mjs, which serves the
# streamable MCP endpoint at /mcp?redis_channel=<messageId>_chrome_mcp.
set -e

case "${HEADFUL:-}" in
  1 | true | yes | TRUE | YES)
    export DISPLAY="${DISPLAY:-:99}"
    rm -f /tmp/.X99-lock
    echo "[entrypoint] HEADFUL=1 -> starting Xvfb on ${DISPLAY}"
    Xvfb "${DISPLAY}" -screen 0 "${XVFB_RESOLUTION:-1440x900x24}" -ac >/tmp/xvfb.log 2>&1 &
    # Give Xvfb a moment to come up before Chrome tries to connect.
    sleep 1
    ;;
  *)
    echo "[entrypoint] headless mode (set HEADFUL=1 to enable headed/Xvfb)"
    ;;
esac

exec node /app/scripts/goose-http-entrypoint.mjs
