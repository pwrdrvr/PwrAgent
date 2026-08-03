#!/usr/bin/env bash
# Install the launchd agent that keeps PwrAgent's persistent runner online.

set -euo pipefail

LAB_ROOT=${PWRAGENT_MAC_VM_LAB_ROOT:-"$HOME/pwragent-mac-vm"}
LABEL=com.pwragent.gha-runner
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="$LAB_ROOT/runner/run-persistent-runner.sh"

if [[ ! -x "$SCRIPT" ]]; then
  echo "$SCRIPT is missing or not executable" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$SCRIPT</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LAB_ROOT/.runner-agent.log</string>
  <key>StandardErrorPath</key><string>$LAB_ROOT/.runner-agent.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo ">> $LABEL loaded; watch $LAB_ROOT/.runner-agent.log"
