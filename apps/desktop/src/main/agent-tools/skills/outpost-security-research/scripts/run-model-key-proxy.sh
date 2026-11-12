#!/bin/sh
# Run the model key proxy in the foreground from a private env file.
# start-model-key-proxy.sh, launchd and systemd all start the proxy through this script.
#
# Usage: run-model-key-proxy.sh <env-file>
#   The env file (mode 600, never committed) sets MODEL_PROXY_UPSTREAM,
#   MODEL_PROXY_PLACEHOLDER, optionally MODEL_PROXY_LISTEN, and where the key is kept:
#     MODEL_PROXY_API_KEY_SOURCE=op://<vault>/<item>/<field>   read with `op read`
#     MODEL_PROXY_API_KEY_SOURCE=keychain:<service>            macOS Keychain item, account $USER
#   The key is read at every start and is passed only to the proxy process. It is never
#   written to the env file, a plist, a unit file or a log.
#   An env file that sets MODEL_PROXY_API_KEY itself still works, but not together with
#   a source.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
: "${1:?usage: run-model-key-proxy.sh <env-file>}"
# Absolute, so `.` never searches PATH for it.
env_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mode="$(stat -f %Lp "$env_file" 2>/dev/null || stat -c %a "$env_file")"
case "$mode" in 600|400) ;; *) echo "$env_file must be mode 600; it is $mode" >&2; exit 1;; esac
set -a
# shellcheck disable=SC1090 # the operator's own env file.
. "$env_file"
set +a
source="${MODEL_PROXY_API_KEY_SOURCE:-}"
unset MODEL_PROXY_API_KEY_SOURCE
if [ -n "$source" ]; then
  if [ -n "${MODEL_PROXY_API_KEY:-}" ]; then
    echo "$env_file sets both MODEL_PROXY_API_KEY and MODEL_PROXY_API_KEY_SOURCE; remove the key line" >&2
    exit 1
  fi
  case "$source" in
    op://*) MODEL_PROXY_API_KEY="$(op read "$source")" ;;
    keychain:?*) MODEL_PROXY_API_KEY="$(security find-generic-password -a "$(id -un)" -s "${source#keychain:}" -w)" ;;
    *) echo "MODEL_PROXY_API_KEY_SOURCE must start with op:// or keychain:" >&2; exit 2 ;;
  esac
  if [ -z "$MODEL_PROXY_API_KEY" ]; then
    echo "the key source $source returned an empty key" >&2
    exit 1
  fi
  export MODEL_PROXY_API_KEY
fi
exec node "$here/model-key-proxy.mjs"
