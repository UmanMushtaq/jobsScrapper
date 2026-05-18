#!/bin/bash
# Remove the launchd auto-start agents installed by setup-autostart.sh

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

for plist in "$LAUNCH_AGENTS/com.jobscrapper.proxy.plist" "$LAUNCH_AGENTS/com.jobscrapper.cloudflared.plist"; do
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm "$plist"
    echo "Removed $(basename "$plist")"
  fi
done

echo "Done. Auto-start agents removed."
