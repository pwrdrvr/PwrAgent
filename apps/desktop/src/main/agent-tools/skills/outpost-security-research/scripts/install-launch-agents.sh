#!/bin/sh
# Keep the host relay and the model key proxy running on macOS, as launchd user agents.
# Each agent starts at login and restarts whenever its process exits. A plist holds paths,
# hosts and ports, never a key: the proxy reads its key at every start (run-model-key-proxy.sh).
#
# Usage:
#   install-launch-agents.sh relay <gateway-host> <gateway-port> [listen-host] [listen-port]
#   install-launch-agents.sh proxy <env-file>
#   install-launch-agents.sh remove relay
#   install-launch-agents.sh remove proxy <env-file>
#
#   The relay listens on 127.0.0.1:47833 unless told otherwise.
#   Labels: ai.pwragent.outpost.relay and ai.pwragent.outpost.proxy.<env-file name>.
#   The scripts are copied to $OUTPOST_HOST_DIR/bin (default ~/.config/outpost/bin), so the
#   agents keep working when this folder moves. Logs go to ~/Library/Logs/pwragent-outpost/.
#   The agents run the node (and op) found on PATH now. Run this again after changing either.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
uid="$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/pwragent-outpost"
bin_dir="${OUTPOST_HOST_DIR:-$HOME/.config/outpost}/bin"

die() { echo "$*" >&2; exit 2; }
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
check_host() { case "$1" in ""|*[!A-Za-z0-9.:_-]*) die "bad host: $1";; esac; }
check_port() {
  case "$1" in ""|*[!0-9]*) die "bad port: $1";; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "bad port: $1"
}
env_label() {
  name="$(basename "$1")"
  name="${name%.env}"
  case "$name" in ""|.*|*[!A-Za-z0-9._-]*) die "rename the env file to letters, digits, dot, dash or underscore: $1";; esac
  echo "ai.pwragent.outpost.proxy.$name"
}
abs_file() { (cd "$(dirname "$1")" && echo "$(pwd)/$(basename "$1")"); }

unload() {
  launchctl bootout "gui/$uid/$1" 2>/dev/null || true
  # bootout returns before the job is gone; wait so bootstrap does not race it.
  tries=0
  while launchctl print "gui/$uid/$1" >/dev/null 2>&1 && [ "$tries" -lt 20 ]; do
    sleep 0.5
    tries=$((tries + 1))
  done
}

# write_agent <label> <PATH value> <argument>...
write_agent() {
  label="$1"
  path_value="$2"
  shift 2
  plist="$agents_dir/$label.plist"
  log="$log_dir/$label.log"
  mkdir -p "$agents_dir"
  # launchd opens the log itself, without the job's Umask; create it private first.
  (umask 077 && mkdir -p "$log_dir" && touch "$log")
  chmod 600 "$log"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo "  <key>Label</key><string>$(xml "$label")</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    for arg in "$@"; do echo "    <string>$(xml "$arg")</string>"; done
    echo '  </array>'
    echo '  <key>EnvironmentVariables</key>'
    echo "  <dict><key>PATH</key><string>$(xml "$path_value")</string></dict>"
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>ThrottleInterval</key><integer>15</integer>'
    echo '  <key>Umask</key><integer>63</integer>'
    echo "  <key>StandardOutPath</key><string>$(xml "$log")</string>"
    echo "  <key>StandardErrorPath</key><string>$(xml "$log")</string>"
    echo '</dict>'
    echo '</plist>'
  } > "$plist.tmp"
  plutil -lint -s "$plist.tmp"
  mv "$plist.tmp" "$plist"
  unload "$label"
  launchctl bootstrap "gui/$uid" "$plist"
  sleep 2
  echo "Loaded $label; log $log"
  tail -2 "$log" 2>/dev/null || true
}

copy_scripts() {
  mkdir -p "$bin_dir"
  for file in tcp-relay.mjs model-key-proxy.mjs run-model-key-proxy.sh; do
    cp "$here/$file" "$bin_dir/$file.tmp"
    mv "$bin_dir/$file.tmp" "$bin_dir/$file"
  done
  chmod 755 "$bin_dir/run-model-key-proxy.sh"
}

find_node() {
  node_bin="$(command -v node)" || die "node is not on PATH"
  base_path="$(dirname "$node_bin"):/usr/bin:/bin:/usr/sbin:/sbin"
}

case "${1:-}" in
  relay)
    [ "$#" -ge 3 ] || die "usage: install-launch-agents.sh relay <gateway-host> <gateway-port> [listen-host] [listen-port]"
    check_host "$2"; check_port "$3"
    listen_host="${4:-127.0.0.1}"; listen_port="${5:-47833}"
    check_host "$listen_host"; check_port "$listen_port"
    find_node
    copy_scripts
    write_agent ai.pwragent.outpost.relay "$base_path" \
      "$node_bin" "$bin_dir/tcp-relay.mjs" "$listen_host" "$listen_port" "$2" "$3"
    ;;
  proxy)
    [ "$#" -eq 2 ] || die "usage: install-launch-agents.sh proxy <env-file>"
    env_file="$(abs_file "$2")"
    label="$(env_label "$env_file")"
    mode="$(stat -f %Lp "$env_file")"
    case "$mode" in 600|400) ;; *) die "$env_file must be mode 600; it is $mode";; esac
    find_node
    path_value="$base_path"
    # shellcheck disable=SC1090 # the operator's own env file.
    source="$(set -a; . "$env_file"; printf '%s' "${MODEL_PROXY_API_KEY_SOURCE:-}")"
    if [ "${source#op://}" != "$source" ]; then
      op_bin="$(command -v op)" || die "$env_file reads its key with op, and op is not on PATH"
      path_value="$(dirname "$op_bin"):$path_value"
    fi
    copy_scripts
    # A proxy started by start-model-key-proxy.sh holds the same port.
    if [ -f "$env_file.pid" ] && kill -0 "$(cat "$env_file.pid")" 2>/dev/null; then
      kill "$(cat "$env_file.pid")"
      rm -f "$env_file.pid"
      sleep 1
    fi
    write_agent "$label" "$path_value" /bin/sh "$bin_dir/run-model-key-proxy.sh" "$env_file"
    ;;
  remove)
    case "${2:-}" in
      relay) label=ai.pwragent.outpost.relay ;;
      proxy) [ "$#" -eq 3 ] || die "usage: install-launch-agents.sh remove proxy <env-file>"; label="$(env_label "$3")" ;;
      *) die "usage: install-launch-agents.sh remove relay | remove proxy <env-file>" ;;
    esac
    unload "$label"
    rm -f "$agents_dir/$label.plist"
    echo "Removed $label"
    ;;
  *)
    die "usage: install-launch-agents.sh relay <gateway-host> <gateway-port> [listen-host] [listen-port] | proxy <env-file> | remove relay | remove proxy <env-file>"
    ;;
esac
