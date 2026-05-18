#!/bin/bash
# Run this on your Mac to proxy APEC and RemoteOK through your home IP.
# Requires: Node.js 18+, cloudflared (brew install cloudflared)
#
# Usage:
#   chmod +x proxy/start-mac.sh
#   JOB_PROXY_SECRET=your-secret ./proxy/start-mac.sh
#
# Copy the tunnel URL it prints and add it to Render as JOB_PROXY_URL.

set -e

if [ -z "$JOB_PROXY_SECRET" ]; then
  echo "ERROR: Set JOB_PROXY_SECRET first."
  echo "  Example: JOB_PROXY_SECRET=my-secret-token ./proxy/start-mac.sh"
  exit 1
fi

if ! command -v cloudflared &> /dev/null; then
  echo "cloudflared not found. Install it with:"
  echo "  brew install cloudflared"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-9876}"

echo "Starting proxy on port $PORT..."
node "$SCRIPT_DIR/index.js" &
PROXY_PID=$!

sleep 1

echo ""
echo "Starting Cloudflare tunnel..."
echo ">>> Copy the https://....trycloudflare.com URL below and set it as JOB_PROXY_URL in Render <<<"
echo ""

# Trap Ctrl+C to kill both processes cleanly
trap "echo ''; echo 'Stopping...'; kill $PROXY_PID 2>/dev/null; exit 0" INT TERM

cloudflared tunnel --url "http://localhost:$PORT" 2>&1 &
TUNNEL_PID=$!

wait $TUNNEL_PID
kill $PROXY_PID 2>/dev/null
