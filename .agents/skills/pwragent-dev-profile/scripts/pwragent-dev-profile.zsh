#!/bin/zsh
set -u

usage() {
  cat <<'USAGE'
Usage:
  pwragent-dev-profile.zsh start   [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH] [--timeout SECONDS]
  pwragent-dev-profile.zsh restart [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH] [--timeout SECONDS]
  pwragent-dev-profile.zsh close   [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH]
  pwragent-dev-profile.zsh status  [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH]
  pwragent-dev-profile.zsh verify  [--root PATH] [--profile NAME] [--log PATH] [--pid-file PATH] [--timeout SECONDS]

Manages a detached local PwrAgent Electron dev app with PWRAGENT_PROFILE=dev.
The default root is the current working directory.
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

process_with_env() {
  ps eww -p "$1" -o command= 2>/dev/null
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

is_under_root() {
  local value="$1"
  [[ "$value" == "$root" || "$value" == "$root/"* ]]
}

command_mentions_root() {
  [[ "$1" == *"$root"* ]]
}

process_has_profile() {
  local command_with_env

  command_with_env="$(process_with_env "$1")"
  [[ "$command_with_env" == *"PWRAGENT_PROFILE=$profile"* ]]
}

is_dev_command() {
  local command="$1"
  [[ "$command" == *"pnpm dev"* ]] && return 0
  [[ "$command" == *"pnpm --filter @pwragent/desktop dev"* ]] && return 0
  [[ "$command" == *"electron-vite"* && "$command" == *"dev"* ]] && return 0
  [[ "$command" == *"scripts/rebuild-native-for-electron.mjs"* ]] && return 0
  [[ "$command" == *"Electron.app"* && "$command" == *"apps/desktop"* ]] && return 0
  [[ "$command" == *"PwrAgent"* && "$command" == *"apps/desktop"* ]] && return 0
  return 1
}

pid_is_root_scoped_dev() {
  local pid="$1"
  local command cwd

  is_self_or_parent "$pid" && return 1

  command="$(process_command "$pid")"
  [[ -n "$command" ]] || return 1
  is_dev_command "$command" || return 1
  process_has_profile "$pid" || return 1

  cwd="$(cwd_of_pid "$pid")"
  if [[ -n "$cwd" ]] && is_under_root "$cwd"; then
    return 0
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

pid_file_pids() {
  local managed_pid

  [[ -f "$pid_file" ]] || return 0
  managed_pid="$(tr -dc '0-9' < "$pid_file")"
  [[ -n "$managed_pid" ]] || return 0
  is_self_or_parent "$managed_pid" && return 0

  if is_live_pid "$managed_pid" && pid_is_root_scoped_dev "$managed_pid"; then
    print -r -- "$managed_pid"
    descendants_of "$managed_pid"
  fi
}

matching_dev_pids() {
  local pid parent command

  {
    pid_file_pids
    pgrep -f 'pnpm.*dev|electron-vite.*dev|scripts/rebuild-native-for-electron.mjs|Electron.app|PwrAgent' 2>/dev/null | while read -r pid; do
      [[ -z "$pid" ]] && continue
      if pid_is_root_scoped_dev "$pid"; then
        print -r -- "$pid"
        descendants_of "$pid"

        parent="$(parent_pid "$pid")"
        while [[ -n "$parent" && "$parent" != "0" && "$parent" != "1" ]]; do
          is_self_or_parent "$parent" && break
          command="$(process_command "$parent")"
          if [[ -n "$command" ]] && is_dev_command "$command"; then
            print -r -- "$parent"
            parent="$(parent_pid "$parent")"
          else
            break
          fi
        done
      fi
    done
  } | sort -rnu
}

describe_pids() {
  local pid

  for pid in $(matching_dev_pids); do
    ps -p "$pid" -o pid=,ppid=,command= 2>/dev/null || true
  done
}

write_status() {
  local rows

  rows="$(describe_pids)"
  if [[ -z "$rows" ]]; then
    say "no $profile profile dev app processes found for $root"
    return 1
  fi

  say "$profile profile dev app processes for $root:"
  print -r -- "$rows"
  return 0
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
  local remaining

  mkdir -p "${log_path:h}" || die "failed to create log directory: ${log_path:h}"
  log_line "close root=$root profile=$profile" >> "$log_path"

  if [[ -z "$(matching_dev_pids)" ]]; then
    rm -f "$pid_file"
    say "no $profile profile dev app processes found for $root"
    return 0
  fi

  stop_matches TERM >> "$log_path"
  sleep 5

  remaining="$(matching_dev_pids)"
  if [[ -n "$remaining" ]]; then
    stop_matches KILL >> "$log_path"
  fi

  rm -f "$pid_file"
  say "closed $profile profile dev app for $root"
}

has_started_process() {
  local pid command

  for pid in $(matching_dev_pids); do
    command="$(process_command "$pid")"
    [[ "$command" == *"electron-vite"* && "$command" == *"dev"* ]] && return 0
    [[ "$command" == *"Electron.app"* ]] && return 0
    [[ "$command" == *"PwrAgent"* && "$command" == *"apps/desktop"* ]] && return 0
  done

  return 1
}

tail_log() {
  if [[ -f "$log_path" ]]; then
    tail -80 "$log_path"
  else
    say "log does not exist yet: $log_path"
  fi
}

verify_app() {
  local elapsed=0
  local sleep_step=2
  local managed_pid=""

  [[ -f "$pid_file" ]] && managed_pid="$(tr -dc '0-9' < "$pid_file")"

  while (( elapsed <= timeout )); do
    if [[ -n "$managed_pid" ]] && ! is_live_pid "$managed_pid"; then
      say "managed process exited before verification completed (pid=$managed_pid)"
      tail_log
      return 1
    fi

    if has_started_process; then
      sleep 3
      if [[ -z "$managed_pid" ]] || is_live_pid "$managed_pid"; then
        say "$profile profile dev app is running for $root"
        say "log: $log_path"
        return 0
      fi
    fi

    sleep "$sleep_step"
    elapsed=$((elapsed + sleep_step))
  done

  say "timed out waiting ${timeout}s for $profile profile dev app to come up"
  tail_log
  return 1
}

start_app() {
  local start_pid command

  [[ -f "$root/package.json" ]] || die "root does not look like the PwrAgent repository root: $root"
  mkdir -p "${log_path:h}" || die "failed to create log directory: ${log_path:h}"

  close_app

  log_line "start root=$root profile=$profile command=PWRAGENT_PROFILE=$profile pnpm dev" >> "$log_path"
  command="cd $(shell_quote "$root") && exec env PWRAGENT_PROFILE=$(shell_quote "$profile") pnpm dev"
  nohup /bin/zsh -lc "$command" >> "$log_path" 2>&1 &
  start_pid="$!"
  print -r -- "$start_pid" > "$pid_file"

  say "started $profile profile dev app supervisor pid=$start_pid"
  say "log: $log_path"
  verify_app
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

[[ "$mode" == "start" || "$mode" == "restart" || "$mode" == "close" || "$mode" == "status" || "$mode" == "verify" ]] || die "unknown mode: $mode"
[[ "$timeout" == <-> ]] || die "--timeout must be an integer number of seconds"

root="${root:A}"
[[ -d "$root" ]] || die "root does not exist: $root"

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
esac
