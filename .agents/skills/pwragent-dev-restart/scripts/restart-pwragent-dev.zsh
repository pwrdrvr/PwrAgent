#!/bin/zsh
set -u

usage() {
  cat <<'USAGE'
Usage:
  restart-pwragent-dev.zsh schedule [--root PATH] [--delay SECONDS] [--log PATH] [--dry-run]
  restart-pwragent-dev.zsh restart-now [--root PATH] [--log PATH] [--dry-run] [--detach-start]

Schedules or performs a local PwrAgent dev restart. The restart stops processes
that match the target checkout path plus the bounded parent dev-server chain,
then starts `pnpm dev` from the target checkout.
USAGE
}

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

shell_quote() {
  printf "%q" "$1"
}

log_line() {
  print -r -- "[$(timestamp)] $*"
}

die() {
  print -u2 -r -- "restart-pwragent-dev: $*"
  exit 1
}

mode="${1:-}"
if [[ -z "$mode" || "$mode" == "--help" || "$mode" == "-h" ]]; then
  usage
  exit 0
fi
shift

root="/Users/huntharo/github/PwrAgnt"
delay="30"
log_path=""
dry_run="false"
detach_start="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || die "--root requires a path"
      root="$2"
      shift 2
      ;;
    --delay)
      [[ $# -ge 2 ]] || die "--delay requires seconds"
      delay="$2"
      shift 2
      ;;
    --log)
      [[ $# -ge 2 ]] || die "--log requires a path"
      log_path="$2"
      shift 2
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --detach-start)
      detach_start="true"
      shift
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$mode" == "schedule" || "$mode" == "restart-now" ]] || die "unknown mode: $mode"
[[ "$delay" == <-> ]] || die "--delay must be an integer number of seconds"

root="${root:A}"
[[ -d "$root" ]] || die "root does not exist: $root"

if [[ -z "$log_path" ]]; then
  log_path="$root/.local/pwragent-dev-restart.log"
fi
mkdir -p "${log_path:h}" || die "failed to create log directory: ${log_path:h}"

script_path="${0:A}"

matching_pids() {
  local command pattern="$1"
  pgrep -f "$pattern" 2>/dev/null | while read -r pid; do
    [[ -z "$pid" ]] && continue
    [[ "$pid" == "$$" ]] && continue
    [[ "$pid" == "$PPID" ]] && continue
    command="$(process_command "$pid")"
    [[ "$command" == *"restart-pwragent-dev.zsh"* ]] && continue
    print -r -- "$pid"
  done
}

parent_pid() {
  ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null
}

is_dev_chain_parent() {
  local command="$1"
  [[ "$command" == *"pnpm dev"* ]] && return 0
  [[ "$command" == *"pnpm --filter @pwragent/desktop dev"* ]] && return 0
  [[ "$command" == *"electron-vite"* && "$command" == *"dev"* ]] && return 0
  [[ "$command" == *"scripts/rebuild-native-for-electron.mjs"* && "$command" == *"electron-vite dev"* ]] && return 0
  return 1
}

candidate_pids() {
  local command parent pid
  for pid in $(matching_pids "$root"); do
    [[ "$pid" != "$$" && "$pid" != "$PPID" ]] && print -r -- "$pid"

    parent="$(parent_pid "$pid")"
    while [[ -n "$parent" && "$parent" != "0" && "$parent" != "1" ]]; do
      [[ "$parent" == "$$" || "$parent" == "$PPID" ]] && break
      command="$(process_command "$parent")"
      if [[ "$command" == *"$root"* ]] || is_dev_chain_parent "$command"; then
        print -r -- "$parent"
        parent="$(parent_pid "$parent")"
      else
        break
      fi
    done
  done | sort -rnu
}

describe_candidates() {
  local pid
  for pid in $(candidate_pids); do
    ps -p "$pid" -o pid=,ppid=,command= 2>/dev/null || true
  done
}

log_candidates() {
  log_line "candidate processes:"
  describe_candidates | while read -r line; do log_line "$line"; done
}

stop_matches() {
  local signal="$1"
  local pid
  for pid in $(candidate_pids); do
    log_line "$signal pid=$pid"
    if [[ "$dry_run" != "true" ]]; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

schedule_restart() {
  local command restart_command
  restart_command="$(shell_quote "$script_path") restart-now --root $(shell_quote "$root") --log $(shell_quote "$log_path") --detach-start"
  [[ "$dry_run" == "true" ]] && restart_command="$restart_command --dry-run"
  command="sleep $(shell_quote "$delay"); nohup /bin/zsh -lc $(shell_quote "$restart_command") >> $(shell_quote "$log_path") 2>&1 &"

  log_line "schedule root=$root delay=${delay}s log=$log_path dryRun=$dry_run"
  log_line "scheduled command: $command"

  if [[ "$dry_run" == "true" ]]; then
    log_line "restart command: $restart_command"
    log_candidates
    return 0
  fi

  nohup /bin/zsh -lc "$command" >> "$log_path" 2>&1 &
  log_line "submitted nohup pid=$!"
}

restart_now() {
  log_line "restart starting root=$root dryRun=$dry_run"
  log_candidates

  stop_matches TERM

  if [[ "$dry_run" == "true" ]]; then
    log_line "dry run complete; pnpm dev not started"
    return 0
  fi

  sleep 5
  stop_matches KILL

  log_line "starting pnpm dev in $root"
  if [[ "$detach_start" == "true" ]]; then
    nohup /bin/zsh -lc "cd $(shell_quote "$root") && pnpm dev" >> "$log_path" 2>&1 &
    log_line "started detached pnpm dev pid=$!"
    return 0
  fi

  exec /bin/zsh -lc "cd $(shell_quote "$root") && pnpm dev"
}

run_main() {
  case "$mode" in
    schedule) schedule_restart ;;
    restart-now) restart_now ;;
  esac
}

if [[ "$dry_run" == "true" ]]; then
  run_main
else
  run_main >> "$log_path" 2>&1
fi
