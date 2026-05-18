#!/bin/bash
# Install macOS launchd agents so the proxy + Cloudflare tunnel start automatically
# at login and restart themselves if they crash or your Mac wakes from sleep.
#
# Run ONCE to install. You never need to start the proxy manually again.
#
# Prerequisites:
#   1. Node.js 18+  (brew install node)
#   2. cloudflared  (brew install cloudflared)
#   3. Named tunnel configured (see NAMED TUNNEL SETUP below)
#
# Usage:
#   JOB_PROXY_SECRET=your-secret ./proxy/setup-autostart.sh
#
# ─────────────────────────────────────────────────────────────
# NAMED TUNNEL SETUP (one-time, gives you a permanent URL)
# ─────────────────────────────────────────────────────────────
#   1. cloudflared tunnel login          # opens browser, authorizes your account
#   2. cloudflared tunnel create job-proxy   # creates the tunnel (skip if already done)
#   3. Go to Cloudflare Zero Trust → Networks → Tunnels → job-proxy
#      → Public Hostname → Add hostname:
#        Subdomain: job-proxy   Domain: your-domain.com   Service: http://localhost:9876
#   4. Copy the permanent URL (e.g. https://job-proxy.your-domain.com)
#      and set it as JOB_PROXY_URL in Render — you never need to update it again.
# ─────────────────────────────────────────────────────────────

set -e

if [ -z "$JOB_PROXY_SECRET" ]; then
  echo "ERROR: Set JOB_PROXY_SECRET first."
  echo "  Example: JOB_PROXY_SECRET=my-secret ./proxy/setup-autostart.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9876}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

NODE_BIN="$(command -v node 2>/dev/null || echo '')"
CLOUDFLARED_BIN="$(command -v cloudflared 2>/dev/null || echo '')"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install it: brew install node"
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
echo "Proxy agent installed and started (port $PORT)"

# ── 2. Cloudflared named tunnel plist ─────────────────────────────────────
if [ -z "$CLOUDFLARED_BIN" ]; then
  echo ""
  echo "WARNING: cloudflared not found — skipping tunnel agent."
  echo "  Install it: brew install cloudflared"
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
        <string>$CLOUDFLARED_BIN</string>
        <string>tunnel</string>
        <string>run</string>
        <string>job-proxy</string>
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

  launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
  launchctl load "$TUNNEL_PLIST"
  echo "Cloudflare tunnel agent installed and started (named tunnel: job-proxy)"
fi

echo ""
echo "Done. Services now start automatically at login and restart on crash."
echo ""
echo "Useful commands:"
echo "  Check status:       launchctl list | grep jobscrapper"
echo "  Proxy logs:         tail -f /tmp/jobscrapper-proxy.log"
echo "  Tunnel logs:        tail -f /tmp/jobscrapper-cloudflared.log"
echo "  Stop proxy:         launchctl unload $PROXY_PLIST"
echo "  Stop tunnel:        launchctl unload $LAUNCH_AGENTS/com.jobscrapper.cloudflared.plist"
echo "  Uninstall all:      ./proxy/remove-autostart.sh"
