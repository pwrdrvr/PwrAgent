#!/bin/sh
# Start the model key proxy in the background from a private env file, until logout.
# To keep it running across logouts and reboots, use install-launch-agents.sh instead.
#
# Usage: start-model-key-proxy.sh <env-file>
#   The env file (mode 600, never committed) is described in run-model-key-proxy.sh.
#   The proxy logs JSON lines to <env-file>.log, with the placeholder redacted.
#   A previous proxy started from the same env file is stopped first.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
env_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
# GNU stat first: its -f prints file system status instead of failing.
mode="$(stat -c %a "$env_file" 2>/dev/null || stat -f %Lp "$env_file")"
case "$mode" in 600|400) ;; *) echo "$env_file must be mode 600; it is $mode" >&2; exit 1;; esac
pid_file="$env_file.pid"
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  kill "$(cat "$pid_file")"
  sleep 1
fi
nohup sh "$here/run-model-key-proxy.sh" "$env_file" >> "$env_file.log" 2>&1 &
echo $! > "$pid_file"
sleep 1
tail -1 "$env_file.log"
