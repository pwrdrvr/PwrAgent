#!/usr/bin/env bash
set -euo pipefail

# Xvfb supplies a display, but no window manager to acknowledge EWMH state
# changes such as Electron's setAlwaysOnTop. Own the manager for this lane.
openbox --sm-disable > /tmp/pwragent-e2e-openbox.log 2>&1 &
window_manager_pid=$!
cleanup() {
  kill "$window_manager_pid" 2>/dev/null || true
  wait "$window_manager_pid" 2>/dev/null || true
}
trap cleanup EXIT

manager_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if ! kill -0 "$window_manager_pid" 2>/dev/null; then
    cat /tmp/pwragent-e2e-openbox.log >&2
    exit 1
  fi
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'; then
    manager_ready=true
    break
  fi
  sleep 0.1
done
if [[ "$manager_ready" != true ]]; then
  echo "Window manager did not publish its EWMH readiness property." >&2
  exit 1
fi

pnpm --filter @pwragent/desktop test:e2e "$@"
