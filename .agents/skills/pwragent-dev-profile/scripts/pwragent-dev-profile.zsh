#!/bin/zsh
set -u

INSTANCE_ROOT_ENV="PWRAGENT_INSTANCE_ROOT"
SCRIPT_SOURCE="${(%):-%x}"
SCRIPT_DIR="${SCRIPT_SOURCE:A:h}"

usage() {
  cat <<'USAGE'
Usage:
  pwragent-dev-profile.zsh start   [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH] [--timeout SECONDS]
  pwragent-dev-profile.zsh restart [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH] [--timeout SECONDS]
  pwragent-dev-profile.zsh close   [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH]
  pwragent-dev-profile.zsh status  [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH]
  pwragent-dev-profile.zsh verify  [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH] [--timeout SECONDS]
  pwragent-dev-profile.zsh leases  [--profile NAME]
  pwragent-dev-profile.zsh self-test

Manages a detached local PwrAgent Electron dev app with PWRAGENT_PROFILE=dev.
Process ownership is resolved from the app's profile runtime lease records.
USAGE
}

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

shell_quote() {
  printf "%q" "$1"
}

say() {
  print -r -- "pwragent-dev-profile: $*"
}

log_line() {
  print -r -- "[$(timestamp)] $*"
}

die() {
  print -u2 -r -- "pwragent-dev-profile: $*"
  exit 1
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null
}

parent_pid() {
  ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '
}

cwd_of_pid() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

is_live_pid() {
  [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null
}

is_self_or_parent() {
  [[ "$1" == "$$" || "$1" == "$PPID" ]]
}

is_valid_profile() {
  [[ "$1" =~ '^[a-z0-9][a-z0-9_-]{0,31}$' && "$1" != "." && "$1" != ".." && "$1" != "con" && "$1" != "nul" && "$1" != "aux" && "$1" != "prn" ]]
}

is_under_root() {
  local value="$1"
  [[ "$value" == "$root" || "$value" == "$root/"* ]]
}

is_path_boundary_before() {
  local character="${1:-}"

  [[ -z "$character" || "$character" == " " || "$character" == $'\t' || "$character" == "'" || "$character" == '"' || "$character" == "=" ]]
}

is_path_boundary_after() {
  local character="${1:-}"

  [[ -z "$character" || "$character" == "/" || "$character" == " " || "$character" == $'\t' || "$character" == "'" || "$character" == '"' ]]
}

command_mentions_root() {
  local command="$1"
  local rest="$command"
  local before after previous next

  while [[ "$rest" == *"$root"* ]]; do
    before="${rest%%"$root"*}"
    after="${rest#*"$root"}"
    previous="${before[-1]:-}"
    next="${after[1]:-}"

    if is_path_boundary_before "$previous" && is_path_boundary_after "$next"; then
      return 0
    fi

    rest="$after"
  done

  return 1
}

is_dev_command() {
  local command="$1"
  [[ "$command" == *"pnpm dev"* ]] && return 0
  [[ "$command" == *"pnpm --filter @pwragent/desktop dev"* ]] && return 0
  [[ "$command" == *"pwragent-dev-profile-daemon.mjs"* ]] && return 0
  [[ "$command" == *"electron-vite"* && "$command" == *"dev"* ]] && return 0
  [[ "$command" == *"scripts/rebuild-native-for-electron.mjs"* ]] && return 0
  [[ "$command" == *"Electron.app"* && "$command" == *"apps/desktop"* ]] && return 0
  [[ "$command" == *"PwrAgent"* && "$command" == *"apps/desktop"* ]] && return 0
  return 1
}

root_scoped_dev_pid() {
  local pid="$1"
  local command cwd

  is_self_or_parent "$pid" && return 1

  command="$(process_command "$pid")"
  [[ -n "$command" ]] || return 1
  is_dev_command "$command" || return 1

  cwd="$(cwd_of_pid "$pid")"
  if [[ -n "$cwd" ]]; then
    is_under_root "$cwd"
    return $?
  fi

  command_mentions_root "$command"
}

descendants_of() {
  local parent="$1"
  local child

  pgrep -P "$parent" 2>/dev/null | while read -r child; do
    [[ -z "$child" ]] && continue
    print -r -- "$child"
    descendants_of "$child"
  done
}

dev_parent_chain_of() {
  local parent command

  parent="$(parent_pid "$1")"
  while [[ -n "$parent" && "$parent" != "0" && "$parent" != "1" ]]; do
    is_self_or_parent "$parent" && break
    command="$(process_command "$parent")"
    if [[ -n "$command" ]] && is_dev_command "$command" && root_scoped_dev_pid "$parent"; then
      print -r -- "$parent"
      parent="$(parent_pid "$parent")"
    else
      break
    fi
  done
}

compute_root_hash() {
  printf '%s' "${1:A}" | shasum -a 256 | awk '{ print substr($1, 1, 16) }'
}

state_db_path() {
  local pwragent_home="${PWRAGENT_HOME:-$HOME/.pwragent}"
  print -r -- "${pwragent_home:A}/profiles/$profile/state/state.db"
}

launch_job_label() {
  print -r -- "local.pwragent.dev-profile.$profile.$root_hash_value"
}

launch_job_pid() {
  command -v launchctl >/dev/null 2>&1 || return 1
  launchctl list 2>/dev/null | awk -v label="$(launch_job_label)" '$3 == label && $1 ~ /^[0-9]+$/ { print $1; exit }'
}

launch_job_exists() {
  command -v launchctl >/dev/null 2>&1 || return 1
  launchctl list 2>/dev/null | awk -v label="$(launch_job_label)" '$3 == label { found = 1 } END { exit found ? 0 : 1 }'
}

remove_launch_job() {
  launch_job_exists || return 1
  launchctl remove "$(launch_job_label)" >/dev/null 2>&1
}

cleanup_exited_launch_job() {
  launch_job_exists || return 1
  [[ -n "$(launch_job_pid)" ]] && return 1
  remove_launch_job
}

runtime_tables_ready() {
  [[ -f "$state_db" ]] || return 1
  sqlite3 -readonly "$state_db" "SELECT cwd_hash FROM app_runtime_instances LIMIT 0;" >/dev/null 2>&1
}

query_root_instances() {
  runtime_tables_ready || return 1
  sqlite3 -readonly -separator $'\t' "$state_db" \
    "SELECT instance_id, process_id, coalesce(cwd_hint, ''), heartbeat_at,
            desired_messaging_enabled, effective_messaging_enabled,
            coalesce(disabled_reason, '')
     FROM app_runtime_instances
     WHERE profile_name = '$profile'
       AND cwd_hash = '$root_hash_value'
       AND exited_at IS NULL
     ORDER BY heartbeat_at DESC;"
}

query_profile_instances() {
  runtime_tables_ready || return 1
  sqlite3 -readonly -separator $'\t' "$state_db" \
    "SELECT instance_id, process_id, coalesce(cwd_hint, ''), coalesce(cwd_hash, ''),
            heartbeat_at, desired_messaging_enabled, effective_messaging_enabled,
            coalesce(disabled_reason, ''), coalesce(exited_at, '')
     FROM app_runtime_instances
     WHERE profile_name = '$profile'
     ORDER BY heartbeat_at DESC
     LIMIT 20;"
}

query_active_lease() {
  runtime_tables_ready || return 1
  sqlite3 -readonly -separator $'\t' "$state_db" \
    "SELECT l.owner_instance_id, l.heartbeat_at, l.expires_at,
            coalesce(i.process_id, ''), coalesce(i.cwd_hint, ''),
            coalesce(i.cwd_hash, ''), coalesce(i.effective_messaging_enabled, 0)
     FROM messaging_runtime_lease l
     LEFT JOIN app_runtime_instances i
       ON i.instance_id = l.owner_instance_id
     WHERE l.lease_key = 'profile-messaging'
       AND l.status = 'active'
       AND l.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
     LIMIT 1;"
}

managed_app_pids() {
  local instance_id pid cwd_hint heartbeat desired effective disabled

  query_root_instances 2>/dev/null | while IFS=$'\t' read -r instance_id pid cwd_hint heartbeat desired effective disabled; do
    [[ -n "$pid" ]] || continue
    if is_live_pid "$pid"; then
      print -r -- "$pid"
      descendants_of "$pid"
      dev_parent_chain_of "$pid"
    fi
  done
}

pid_file_pids() {
  local managed_pid

  [[ -f "$pid_file" ]] || return 0
  managed_pid="$(tr -dc '0-9' < "$pid_file")"
  [[ -n "$managed_pid" ]] || return 0
  is_self_or_parent "$managed_pid" && return 0

  if is_live_pid "$managed_pid" && root_scoped_dev_pid "$managed_pid"; then
    print -r -- "$managed_pid"
    descendants_of "$managed_pid"
  fi
}

matching_dev_pids() {
  {
    managed_app_pids
    pid_file_pids
  } | sort -rnu
}

describe_matching_processes() {
  local pid

  for pid in $(matching_dev_pids); do
    ps -p "$pid" -o pid=,ppid=,command= 2>/dev/null || true
  done
}

describe_root_instances() {
  local instance_id pid cwd_hint heartbeat desired effective disabled live

  query_root_instances 2>/dev/null | while IFS=$'\t' read -r instance_id pid cwd_hint heartbeat desired effective disabled; do
    live="stale"
    is_live_pid "$pid" && live="live"
    say "instance id=$instance_id pid=$pid $live cwd=$cwd_hint heartbeat=$heartbeat desiredMessaging=$desired effectiveMessaging=$effective disabledReason=${disabled:-none}"
  done
}

describe_active_lease() {
  local owner heartbeat expires pid cwd_hint cwd_hash effective live
  local row

  row="$(query_active_lease 2>/dev/null || true)"
  if [[ -z "$row" ]]; then
    say "no active $profile profile messaging lease"
    return 1
  fi

  IFS=$'\t' read -r owner heartbeat expires pid cwd_hint cwd_hash effective <<< "$row"
  live="unknown"
  if [[ -n "$pid" ]]; then
    live="stale"
    is_live_pid "$pid" && live="live"
  fi
  say "active messaging lease owner=$owner pid=${pid:-unknown} $live cwd=${cwd_hint:-unknown} cwdHash=${cwd_hash:-unknown} effectiveMessaging=$effective expiresAt=$expires"
}

write_status() {
  local rows processes

  if ! runtime_tables_ready; then
    say "no lease metadata yet for profile $profile at $state_db"
    return 1
  fi

  rows="$(query_root_instances 2>/dev/null || true)"
  if [[ -z "$rows" ]]; then
    say "no lease-backed $profile profile app instances found for $root"
    cleanup_exited_launch_job >/dev/null 2>&1 || true
    describe_active_lease >/dev/null || true
    return 1
  fi

  if ! has_live_root_instance; then
    say "only stale lease-backed $profile profile app instances found for $root"
    cleanup_exited_launch_job >/dev/null 2>&1 || true
    describe_root_instances
    describe_active_lease || true
    return 1
  fi

  say "$profile profile app instances for $root:"
  describe_root_instances
  describe_active_lease || true

  processes="$(describe_matching_processes)"
  if [[ -n "$processes" ]]; then
    say "managed process tree:"
    print -r -- "$processes"
  fi
  return 0
}

write_leases() {
  local instance_id pid cwd_hint cwd_hash heartbeat desired effective disabled exited live

  if ! runtime_tables_ready; then
    say "no lease metadata yet for profile $profile at $state_db"
    return 1
  fi

  describe_active_lease || true
  say "recent $profile profile app instances:"
  query_profile_instances | while IFS=$'\t' read -r instance_id pid cwd_hint cwd_hash heartbeat desired effective disabled exited; do
    live="stale"
    [[ -n "$exited" ]] && live="exited"
    [[ -z "$exited" ]] && is_live_pid "$pid" && live="live"
    say "instance id=$instance_id pid=$pid $live cwd=${cwd_hint:-unknown} cwdHash=${cwd_hash:-unknown} heartbeat=$heartbeat desiredMessaging=$desired effectiveMessaging=$effective disabledReason=${disabled:-none}"
  done
}

stop_matches() {
  local signal="$1"
  local pid

  for pid in $(matching_dev_pids); do
    log_line "$signal pid=$pid"
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

close_app() {
  local remaining removed_job=0

  mkdir -p "${log_path:h}" || die "failed to create log directory: ${log_path:h}"
  log_line "close root=$root profile=$profile rootHash=$root_hash_value" >> "$log_path"
  if remove_launch_job; then
    removed_job=1
    log_line "removed launchd job label=$(launch_job_label)" >> "$log_path"
  fi

  if [[ -z "$(matching_dev_pids)" && "$removed_job" == "0" ]]; then
    rm -f "$pid_file"
    say "no lease-backed $profile profile app processes found for $root"
    return 0
  fi

  stop_matches TERM >> "$log_path"
  sleep 5

  remaining="$(matching_dev_pids)"
  if [[ -n "$remaining" ]]; then
    stop_matches KILL >> "$log_path"
  fi

  rm -f "$pid_file"
  say "closed $profile profile app for $root"
}

tail_log() {
  if [[ -f "$log_path" ]]; then
    tail -100 "$log_path"
  else
    say "log does not exist yet: $log_path"
  fi
}

has_live_root_instance() {
  local instance_id pid cwd_hint heartbeat desired effective disabled

  query_root_instances 2>/dev/null | while IFS=$'\t' read -r instance_id pid cwd_hint heartbeat desired effective disabled; do
    [[ -n "$pid" ]] || continue
    if is_live_pid "$pid"; then
      return 0
    fi
  done

  return 1
}

verify_app() {
  local elapsed=0
  local sleep_step=2
  local managed_pid=""

  [[ -f "$pid_file" ]] && managed_pid="$(tr -dc '0-9' < "$pid_file")"

  while (( elapsed <= timeout )); do
    if has_live_root_instance; then
      say "$profile profile app is running for $root"
      say "log: $log_path"
      describe_root_instances
      describe_active_lease || true
      return 0
    fi

    if [[ -n "$managed_pid" ]] && ! is_live_pid "$managed_pid"; then
      say "managed process exited before lease-backed verification completed (pid=$managed_pid)"
      cleanup_exited_launch_job >/dev/null 2>&1 || true
      tail_log
      return 1
    fi

    sleep "$sleep_step"
    elapsed=$((elapsed + sleep_step))
  done

  say "timed out waiting ${timeout}s for lease-backed $profile profile app record"
  cleanup_exited_launch_job >/dev/null 2>&1 || true
  tail_log
  return 1
}

start_app() {
  local start_pid helper_path started_after

  [[ -f "$root/package.json" ]] || die "root does not look like the PwrAgent repository root: $root"
  mkdir -p "${log_path:h}" || die "failed to create log directory: ${log_path:h}"
  helper_path="$SCRIPT_DIR/pwragent-dev-profile-daemon.mjs"
  [[ -f "$helper_path" ]] || die "missing daemon helper: $helper_path"

  close_app

  started_after="$(( $(date +%s) * 1000 ))"
  log_line "start root=$root profile=$profile rootHash=$root_hash_value command=PWRAGENT_PROFILE=$profile $INSTANCE_ROOT_ENV=$root pnpm dev" >> "$log_path"
  start_pid="$(node "$helper_path" --daemonize --root "$root" --profile "$profile" --root-hash "$root_hash_value" --state-db "$state_db" --log "$log_path" --pid-file "$pid_file" --started-after "$started_after")" \
    || die "failed to start detached daemon helper"

  print -r -- "$start_pid" > "$pid_file"

  say "started $profile profile dev app daemon pid=${start_pid:-unknown}"
  say "log: $log_path"
  verify_app
}

assert_success() {
  local description="$1"
  shift

  "$@" || die "self-test failed: expected success for $description"
}

assert_failure() {
  local description="$1"
  shift

  if "$@"; then
    die "self-test failed: expected failure for $description"
  fi
}

run_self_test() {
  root="/Users/example/PwrAgnt"
  root_hash_value="$(compute_root_hash "$root")"
  profile="dev"

  assert_success "valid profile" is_valid_profile "dev"
  assert_failure "profile prefix" is_valid_profile "Dev"
  assert_success "exact root command" command_mentions_root "cd /Users/example/PwrAgnt && pnpm dev"
  assert_success "root child path" command_mentions_root "/Users/example/PwrAgnt/apps/desktop"
  assert_success "root env-style assignment" command_mentions_root "PWD=/Users/example/PwrAgnt"
  assert_failure "sibling checkout prefix" command_mentions_root "/Users/example/PwrAgnt-old/apps/desktop"
  assert_failure "sibling checkout suffix" command_mentions_root "/Users/example/PwrAgnt2/apps/desktop"
  [[ "$root_hash_value" == "c976f17804e892f9" ]] || die "self-test failed: unexpected root hash $root_hash_value"

  say "self-test passed"
}

mode="${1:-}"
if [[ -z "$mode" || "$mode" == "--help" || "$mode" == "-h" ]]; then
  usage
  exit 0
fi
shift

root="${PWD:A}"
profile="dev"
log_path=""
pid_file=""
timeout="120"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || die "--root requires a path"
      root="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || die "--profile requires a name"
      profile="$2"
      shift 2
      ;;
    --log)
      [[ $# -ge 2 ]] || die "--log requires a path"
      log_path="$2"
      shift 2
      ;;
    --pid-file)
      [[ $# -ge 2 ]] || die "--pid-file requires a path"
      pid_file="$2"
      shift 2
      ;;
    --timeout)
      [[ $# -ge 2 ]] || die "--timeout requires seconds"
      timeout="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$mode" == "start" || "$mode" == "restart" || "$mode" == "close" || "$mode" == "status" || "$mode" == "verify" || "$mode" == "leases" || "$mode" == "self-test" ]] || die "unknown mode: $mode"
[[ "$timeout" == <-> ]] || die "--timeout must be an integer number of seconds"
is_valid_profile "$profile" || die "invalid profile: $profile"

root="${root:A}"
[[ -d "$root" ]] || die "root does not exist: $root"
root_hash_value="$(compute_root_hash "$root")"
state_db="$(state_db_path)"

if [[ -z "$log_path" ]]; then
  log_path="$root/.local/pwragent-dev-profile.log"
fi
if [[ -z "$pid_file" ]]; then
  pid_file="$root/.local/pwragent-dev-profile.pid"
fi

case "$mode" in
  start)
    start_app
    ;;
  restart)
    start_app
    ;;
  close)
    close_app
    ;;
  status)
    write_status
    ;;
  verify)
    verify_app
    ;;
  leases)
    write_leases
    ;;
  self-test)
    run_self_test
    ;;
esac
