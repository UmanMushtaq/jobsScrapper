#!/bin/bash
# Install macOS launchd agents for permanent auto-start of the job proxy.
#
# TWO modes:
#   1. NAMED TUNNEL (recommended — permanent URL, never changes):
#      Requires TUNNEL_TOKEN from Cloudflare Zero Trust dashboard.
#      Zero Trust → Tunnels → job-proxy → Configure → copy the token.
#
#   2. QUICK TUNNEL fallback (URL changes on Mac restart):
#      Uses TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to notify you of the new URL.
#
# Usage (named tunnel — permanent):
#   JOB_PROXY_SECRET=your-secret \
#   TUNNEL_TOKEN=eyJhbGciOi... \
#   ./proxy/setup-autostart.sh
#
# Usage (quick tunnel fallback):
#   JOB_PROXY_SECRET=your-secret \
#   TELEGRAM_BOT_TOKEN=your-token \
#   TELEGRAM_CHAT_ID=your-chat-id \
#   ./proxy/setup-autostart.sh

set -e

if [ -z "$JOB_PROXY_SECRET" ]; then
  echo "ERROR: JOB_PROXY_SECRET is required."
  echo "  Example: JOB_PROXY_SECRET=my-secret TUNNEL_TOKEN=eyJ... ./proxy/setup-autostart.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9876}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

NODE_BIN="$(command -v node 2>/dev/null || echo '')"
CLOUDFLARED_BIN="$(command -v cloudflared 2>/dev/null || echo '')"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install: brew install node"
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS"

# ── 1. Proxy server ────────────────────────────────────────────────────────
PROXY_PLIST="$LAUNCH_AGENTS/com.jobscrapper.proxy.plist"

cat > "$PROXY_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jobscrapper.proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$SCRIPT_DIR/index.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>JOB_PROXY_SECRET</key>
        <string>$JOB_PROXY_SECRET</string>
        <key>PORT</key>
        <string>$PORT</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/jobscrapper-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/jobscrapper-proxy-error.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PROXY_PLIST" 2>/dev/null || true
launchctl load "$PROXY_PLIST"
echo "Proxy agent installed (port $PORT)"

# ── 2. Cloudflared tunnel ──────────────────────────────────────────────────
if [ -z "$CLOUDFLARED_BIN" ]; then
  echo ""
  echo "WARNING: cloudflared not found — skipping tunnel agent."
  echo "  Install: brew install cloudflared"
  echo "  Then re-run this script."
  exit 0
fi

TUNNEL_PLIST="$LAUNCH_AGENTS/com.jobscrapper.cloudflared.plist"

if [ -n "$TUNNEL_TOKEN" ]; then
  # ── Named tunnel with token — permanent URL, no login needed ────────────
  cat > "$TUNNEL_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jobscrapper.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>$CLOUDFLARED_BIN</string>
        <string>tunnel</string>
        <string>run</string>
        <string>--token</string>
        <string>$TUNNEL_TOKEN</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/jobscrapper-cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/jobscrapper-cloudflared-error.log</string>
</dict>
</plist>
PLIST

  echo "Cloudflare named tunnel agent installed (permanent URL)"
  echo ""
  echo "Your permanent proxy URL: https://job-proxy.umanmushtaq.com"
  echo "Set this in Render as JOB_PROXY_URL — never needs to change."

else
  # ── Quick tunnel fallback — URL changes on Mac restart ──────────────────
  cat > "$TUNNEL_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jobscrapper.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_DIR/cloudflared-notify.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLOUDFLARED_BIN</key>
        <string>$CLOUDFLARED_BIN</string>
        <key>PORT</key>
        <string>$PORT</string>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>${TELEGRAM_BOT_TOKEN:-}</string>
        <key>TELEGRAM_CHAT_ID</key>
        <string>${TELEGRAM_CHAT_ID:-}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/jobscrapper-cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/jobscrapper-cloudflared-error.log</string>
</dict>
</plist>
PLIST

  echo "Cloudflare quick tunnel agent installed (URL changes on Mac restart)"
  if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo "You will get a Telegram message with the new URL when it changes."
  fi
fi

launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
launchctl load "$TUNNEL_PLIST"

echo ""
echo "Done. Both services start at login and restart automatically."
echo ""
echo "Check logs:"
echo "  Proxy:     tail -f /tmp/jobscrapper-proxy.log"
echo "  Tunnel:    tail -f /tmp/jobscrapper-cloudflared.log"
echo "  Status:    launchctl list | grep jobscrapper"
echo "  Uninstall: ./proxy/remove-autostart.sh"
