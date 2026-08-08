#!/usr/bin/env bash
# Reap Electron process trees that a previous job on this runner leaked, and
# report what was found either way.
#
# The macOS Desktop E2E lane runs on a persistent Tart guest, not a fresh VM
# per job, so anything a previous job left behind survives into the next one.
# The E2E fixture's teardown (apps/desktop/e2e/fixtures/electron-app.ts)
# routinely falls back from a graceful close to killProcessTree plus a fixed
# one-second wait, and that wait is not proof of reaping: Electron helper
# processes can outlive the main pid.
#
# The report matters as much as the kill. A healthy runner starts a job with
# zero leftovers, so a non-zero count is evidence worth surfacing — the next
# time this lane wedges (see the 2026-08-07 M2-Max incident: 0 tests, full
# 20-minute cap, "Launch electron" completing while `Wait for event "window"`
# never returned) the job log will say whether orphans were present or not.
# Stale processes were never proven to cause that wedge; this script exists to
# make the question answerable, and because starting a job with orphans is
# wrong regardless.
#
# Scope, because this machine is shared:
#   * The runner group is shared with PwrSnap, and an operator may be working
#     on the guest. A bare `pkill -f Electron` would take out their work.
#   * Only processes whose command line lives under this runner's own
#     RUNNER_WORKSPACE are eligible. A runner executes one job at a time, so
#     everything matching that path at pre-run time is a leftover, and nothing
#     belonging to PwrSnap or to the operator can match it.
#   * Electron found elsewhere on the guest is counted for the log and left
#     completely alone.
#   * This script runs before the lane launches anything, and it excludes its
#     own process tree, so it cannot kill the current job's processes.

set -euo pipefail

# `RUNNER_WORKSPACE` is <runner>/_work/<repo>; GITHUB_WORKSPACE is the checkout
# beneath it. Prefer the former so a leftover from a previous job's build
# directory still matches, and refuse to run rather than guess a kill scope.
scope="${RUNNER_WORKSPACE:-${GITHUB_WORKSPACE:-}}"
if [[ -z "$scope" ]]; then
  echo "reap-orphan-electron: neither RUNNER_WORKSPACE nor GITHUB_WORKSPACE is set;" >&2
  echo "reap-orphan-electron: refusing to guess a kill scope on a shared machine." >&2
  exit 1
fi

# Ancestors of this script (the step shell, the runner worker, launchd). They
# can never be orphans, and killing one would take down the job.
ancestors=""
ancestor_pid=$$
while [[ "$ancestor_pid" -gt 1 ]]; do
  ancestors="${ancestors}${ancestor_pid},"
  ancestor_pid=$(ps -o ppid= -p "$ancestor_pid" 2>/dev/null | tr -d '[:space:]' || true)
  [[ -n "$ancestor_pid" ]] || break
done

snapshot_file=$(mktemp -t reap-orphan-electron)
matches_file=$(mktemp -t reap-orphan-electron-matches)
trap 'rm -f "$snapshot_file" "$matches_file"' EXIT

# -ww keeps full argument vectors; the helper processes are identified by the
# framework path in argv[0], which would otherwise be truncated.
ps -Awwo pid=,ppid=,state=,etime=,command= >"$snapshot_file"

# Electron main, every helper, and the crashpad handler all carry
# /Electron.app/ in argv[0], because the framework lives inside the bundle and
# the bundle lives under node_modules. That marker plus the scope prefix
# identify exactly this lane's E2E processes.
#
# The marker is passed through the environment rather than as an awk argument
# on purpose: awk's own command line already contains the scope (via -v), so a
# marker in argv would make awk match itself. The process-tree exclusion below
# would still catch it, but a self-match is not a thing to leave one guard
# away from.
# Emitted per match: pid|ppid|state|etime|command
# The last line is always OUTSIDE_SCOPE|<count>.
ELECTRON_BUNDLE_MARKER="/Electron.app/" \
awk -v scope="$scope" -v self="$$" -v ancestors="$ancestors" '
  function is_ours(pid,   walked) {
    while (pid > 1) {
      if (pid == self) return 1
      if (pid in walked) return 0
      walked[pid] = 1
      if (!(pid in parent)) return 0
      pid = parent[pid]
    }
    return 0
  }
  BEGIN {
    marker = ENVIRON["ELECTRON_BUNDLE_MARKER"]
    split(ancestors, ancestor_list, ",")
    for (i in ancestor_list) {
      if (ancestor_list[i] != "") skip[ancestor_list[i]] = 1
    }
  }
  {
    command = ""
    for (i = 5; i <= NF; i++) command = command (i > 5 ? " " : "") $i
    pids[NR] = $1
    ppids[NR] = $2
    states[NR] = $3
    etimes[NR] = $4
    commands[NR] = command
    parent[$1] = $2
    rows = NR
  }
  END {
    outside = 0
    for (row = 1; row <= rows; row++) {
      if (index(commands[row], marker) == 0) continue
      if (pids[row] in skip || is_ours(pids[row])) continue
      if (index(commands[row], scope) == 0) { outside++; continue }
      # A zombie has already exited and is waiting to be reaped by its
      # parent; there is nothing to kill and nothing leaking.
      if (substr(states[row], 1, 1) == "Z") continue
      print pids[row] "|" ppids[row] "|" states[row] "|" etimes[row] "|" commands[row]
    }
    print "OUTSIDE_SCOPE|" outside
  }
' "$snapshot_file" >"$matches_file"

outside_count=$(sed -n 's/^OUTSIDE_SCOPE|//p' "$matches_file")
orphan_lines=$(grep -v '^OUTSIDE_SCOPE|' "$matches_file" || true)
orphan_count=0
if [[ -n "$orphan_lines" ]]; then
  orphan_count=$(printf '%s\n' "$orphan_lines" | wc -l | tr -d '[:space:]')
fi

echo "reap-orphan-electron: scope        $scope"
echo "reap-orphan-electron: in scope     $orphan_count orphaned Electron process(es)"
echo "reap-orphan-electron: out of scope $outside_count Electron process(es) elsewhere on this guest (not touched)"

summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
}

if [[ "$orphan_count" -eq 0 ]]; then
  echo "reap-orphan-electron: nothing to reap; the runner started this job clean."
  summary "### Orphaned Electron check: clean"
  summary ""
  summary "No leftover Electron processes under \`$scope\` before the E2E run."
  summary "(\`$outside_count\` Electron process(es) elsewhere on the guest, left alone.)"
  exit 0
fi

# Elapsed time is the correlation handle: it dates the leftover to a specific
# previous job on this runner.
echo "reap-orphan-electron: leftovers (pid, ppid, state, elapsed, command):"
printf '%s\n' "$orphan_lines" | while IFS='|' read -r pid ppid state etime command; do
  printf '  %-7s ppid=%-7s state=%-4s elapsed=%-14s %.200s\n' \
    "$pid" "$ppid" "$state" "$etime" "$command"
done

echo "::warning title=Orphaned Electron processes on macOS runner::Found $orphan_count leftover Electron process(es) under $scope before this job's E2E run. A healthy runner starts clean; these came from a previous job whose teardown did not reap its process tree."

summary "### Orphaned Electron check: $orphan_count leftover process(es) reaped"
summary ""
summary "A healthy runner starts a job with zero leftovers under \`$scope\`."
summary ""
summary '```'
printf '%s\n' "$orphan_lines" | while IFS='|' read -r pid ppid state etime command; do
  summary "$(printf '%-7s ppid=%-7s state=%-4s elapsed=%-14s %.200s' \
    "$pid" "$ppid" "$state" "$etime" "$command")"
done
summary '```'

orphan_pids=$(printf '%s\n' "$orphan_lines" | cut -d'|' -f1 | tr '\n' ' ')

# TERM first so anything still capable of an orderly exit takes it, then KILL
# whatever ignored it. Both are best-effort: a pid that exits in between is a
# success, not an error.
# shellcheck disable=SC2086
kill -TERM $orphan_pids 2>/dev/null || true
sleep 2
# shellcheck disable=SC2086
kill -KILL $orphan_pids 2>/dev/null || true
sleep 2

# A SIGKILLed process stays in the table as a zombie until its parent reaps
# it, and `kill -0` succeeds on zombies. Ask ps for the state instead: an
# absent pid or a Z state both mean the process is dead and holding nothing.
# Getting this wrong would fail the job for a leftover that was reaped
# correctly.
survivors=""
for pid in $orphan_pids; do
  state=$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$state" && "${state:0:1}" != "Z" ]]; then
    survivors="${survivors}${pid} "
  fi
done

if [[ -n "$survivors" ]]; then
  # SIGKILL is not refusable in user space. A survivor means the process is
  # stuck in the kernel — the vmapple paravirt driver has wedged Electron
  # helpers at birth before — and no amount of retrying here will clear it.
  # Fail now with an actionable message instead of burning the lane's
  # 20-minute cap on a suite that cannot launch a window.
  echo "::error title=Unkillable Electron processes on macOS runner::pid(s) $survivors survived SIGKILL. The guest is wedged at the kernel level and needs to be recycled before this lane can pass."
  summary ""
  summary "**pid(s) \`$survivors\` survived SIGKILL — recycle the guest.**"
  exit 1
fi

echo "reap-orphan-electron: reaped $orphan_count process(es); all confirmed gone."
