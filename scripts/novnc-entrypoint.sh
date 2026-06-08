#!/bin/sh
# Interactive entrypoint: runs a HEADFUL Chrome on a virtual X display and
# exposes it over the web via VNC -> noVNC, so a human can take over the
# remote browser (login, OTP, CAPTCHA, payment).
#
# Ports:
#   8090 -> MCP (streamable_http) at /mcp
#   6080 -> noVNC web UI (open http://localhost:6080/vnc.html)
set -e

export DISPLAY=:99
rm -f /tmp/.X99-lock

# Virtual framebuffer so Chrome can run "headful" without a real screen.
Xvfb :99 -screen 0 1440x900x24 -ac >/tmp/xvfb.log 2>&1 &
sleep 1

# Minimal window manager (keeps Chrome maximized / decorated).
fluxbox >/tmp/fluxbox.log 2>&1 &

# Share the X display over VNC, then bridge VNC -> WebSocket for noVNC.
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -bg -quiet
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

echo "[novnc-entrypoint] noVNC at http://localhost:6080/vnc.html  | MCP at http://localhost:8090/mcp"

# Headful chrome-devtools-mcp rendering onto the Xvfb display, exposed as MCP.
exec /app/node_modules/.bin/mcp-proxy \
  --port 8090 --host 0.0.0.0 --server stream --stateless -- \
  node /app/build/src/bin/chrome-devtools-mcp.js \
  --headless=false \
  --isolated \
  --executablePath=/usr/local/bin/chrome \
  --chrome-arg=--no-sandbox \
  --chrome-arg=--disable-setuid-sandbox \
  --chrome-arg=--disable-dev-shm-usage \
  --chrome-arg=--start-maximized \
  --chrome-arg=--disable-blink-features=AutomationControlled \
  --ignore-default-chrome-arg=--enable-automation
