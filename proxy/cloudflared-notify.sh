#!/bin/bash
# Start a cloudflared quick tunnel and send the URL to Telegram when it connects.
# Used by the launchd auto-start agent — do not run manually.
#
# URL only changes on a full Mac restart (not sleep/wake).
# When it does change, a Telegram message tells you what to update in Render.

CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared)}"
PORT="${PORT:-9876}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [ -z "$CLOUDFLARED_BIN" ]; then
  echo "ERROR: cloudflared not found."
  exit 1
fi

notify() {
  local url="$1"
  echo "[cloudflared] Tunnel URL: $url"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=Proxy tunnel restarted (Mac rebooted).

New URL: ${url}

Go to Render → jobsScrapper → Environment and set:
JOB_PROXY_URL = ${url}" \
      > /dev/null 2>&1 &
  fi
}

"$CLOUDFLARED_BIN" tunnel --url "http://localhost:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  url=$(echo "$line" | grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | head -1)
  if [ -n "$url" ]; then
    notify "$url"
  fi
done
