#!/bin/sh
# Start the model key proxy on the host from a private env file.
#
# Usage: start-model-key-proxy.sh <env-file>
#   The env file (mode 600, never committed) sets MODEL_PROXY_UPSTREAM,
#   MODEL_PROXY_API_KEY, MODEL_PROXY_PLACEHOLDER and optionally MODEL_PROXY_LISTEN.
#   The proxy logs JSON lines to <env-file>.log, with the placeholder redacted.
#   A previous proxy started from the same env file is stopped first.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
env_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mode="$(stat -f %Lp "$env_file" 2>/dev/null || stat -c %a "$env_file")"
case "$mode" in 600|400) ;; *) echo "$env_file must be mode 600 (it holds an API key); it is $mode" >&2; exit 1;; esac
pid_file="$env_file.pid"
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  kill "$(cat "$pid_file")"
  sleep 1
fi
set -a
. "$env_file"
set +a
nohup node "$here/model-key-proxy.mjs" >> "$env_file.log" 2>&1 &
echo $! > "$pid_file"
sleep 1
tail -1 "$env_file.log"
