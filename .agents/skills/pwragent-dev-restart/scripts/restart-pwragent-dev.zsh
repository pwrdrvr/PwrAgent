#!/bin/zsh
set -u

usage() {
  cat <<'USAGE'
Usage:
  restart-pwragent-dev.zsh schedule [--root PATH] [--delay SECONDS] [--log PATH] [--dry-run]
  restart-pwragent-dev.zsh restart-now [--root PATH] [--log PATH] [--dry-run]

Schedules or performs a local PwrAgent dev restart. The restart stops processes
that match the target checkout path or PwrAgent dev user-data path, then starts
`pnpm dev` from the target checkout.
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
user_data_path="/Users/huntharo/Library/Application Support/PwrAgent"

matching_pids() {
  local pattern="$1"
  pgrep -f "$pattern" 2>/dev/null | while read -r pid; do
    [[ -z "$pid" ]] && continue
    [[ "$pid" == "$$" ]] && continue
    [[ "$pid" == "$PPID" ]] && continue
    print -r -- "$pid"
  done
}

parent_pid() {
  ps -p "$1" -o ppid= 2>/dev/null | tr -d ' '
}

candidate_pids() {
  local pattern pid parent
  for pattern in "$root" "$user_data_path"; do
    for pid in $(matching_pids "$pattern"); do
      while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
        [[ "$pid" != "$$" && "$pid" != "$PPID" ]] && print -r -- "$pid"
        parent="$(parent_pid "$pid")"
        [[ -z "$parent" || "$parent" == "$pid" ]] && break
        pid="$parent"
      done
    done
  done | sort -nu
}

describe_candidates() {
  local pid
  for pid in $(candidate_pids); do
    ps -p "$pid" -o pid=,ppid=,command= 2>/dev/null || true
  done
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
  local command
  command="sleep $(shell_quote "$delay"); $(shell_quote "$script_path") restart-now --root $(shell_quote "$root") --log $(shell_quote "$log_path")"
  [[ "$dry_run" == "true" ]] && command="$command --dry-run"

  log_line "schedule root=$root delay=${delay}s log=$log_path dryRun=$dry_run"
  log_line "scheduled command: $command"

  if [[ "$dry_run" == "true" ]]; then
    return 0
  fi

  if command -v launchctl >/dev/null 2>&1; then
    local label="com.pwragent.dev.restart.$(date +%s)"
    launchctl submit -l "$label" -- /bin/zsh -lc "$command"
    log_line "submitted launchctl label=$label"
  else
    nohup /bin/zsh -lc "$command" >> "$log_path" 2>&1 &
    log_line "submitted nohup pid=$!"
  fi
}

restart_now() {
  log_line "restart starting root=$root dryRun=$dry_run"
  log_line "candidate processes:"
  describe_candidates | while read -r line; do log_line "$line"; done

  stop_matches TERM

  if [[ "$dry_run" == "true" ]]; then
    log_line "dry run complete; pnpm dev not started"
    return 0
  fi

  sleep 5
  stop_matches KILL

  log_line "starting pnpm dev in $root"
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
