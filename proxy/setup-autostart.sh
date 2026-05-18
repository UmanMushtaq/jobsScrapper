#!/bin/bash
# Install macOS launchd agents so the proxy + Cloudflare tunnel start automatically
# at login and restart themselves if they crash or your Mac wakes from sleep.
#
# Run ONCE to install. You never need to start the proxy manually again.
#
# Prerequisites:
#   1. Node.js 18+  (brew install node)
#   2. cloudflared  (brew install cloudflared)
#
# Usage:
#   JOB_PROXY_SECRET=your-secret \
#   TELEGRAM_BOT_TOKEN=your-token \
#   TELEGRAM_CHAT_ID=your-chat-id \
#   ./proxy/setup-autostart.sh
#
# TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are optional but recommended.
# When set, you get a Telegram message with the new URL whenever your Mac
# restarts (which is the only time the tunnel URL changes).

set -e

if [ -z "$JOB_PROXY_SECRET" ]; then
  echo "ERROR: Set JOB_PROXY_SECRET first."
  echo ""
  echo "Example:"
  echo "  JOB_PROXY_SECRET=my-secret \\"
  echo "  TELEGRAM_BOT_TOKEN=123:abc \\"
  echo "  TELEGRAM_CHAT_ID=456 \\"
  echo "  ./proxy/setup-autostart.sh"
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

# ── 1. Proxy server plist ──────────────────────────────────────────────────
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

# ── 2. Cloudflared quick tunnel plist ─────────────────────────────────────
if [ -z "$CLOUDFLARED_BIN" ]; then
  echo ""
  echo "WARNING: cloudflared not found — skipping tunnel agent."
  echo "  Install: brew install cloudflared"
  echo "  Then re-run this script."
else
  TUNNEL_PLIST="$LAUNCH_AGENTS/com.jobscrapper.cloudflared.plist"

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

  launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  launchctl load "$TUNNEL_PLIST"
  echo "Cloudflare tunnel agent installed (quick tunnel on port $PORT)"
fi

echo ""
echo "Done. Both services start at login and restart automatically on crash or wake."
echo ""
echo "First-time URL setup:"
echo "  tail -f /tmp/jobscrapper-cloudflared.log"
echo "  Look for the https://....trycloudflare.com line, paste it into Render as JOB_PROXY_URL."
echo ""
echo "After that, the URL only changes when your Mac fully restarts."
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  echo "When it does, you'll get a Telegram message with the new URL."
fi
echo ""
echo "Other commands:"
echo "  Status:       launchctl list | grep jobscrapper"
echo "  Proxy logs:   tail -f /tmp/jobscrapper-proxy.log"
echo "  Tunnel logs:  tail -f /tmp/jobscrapper-cloudflared.log"
echo "  Uninstall:    ./proxy/remove-autostart.sh"
