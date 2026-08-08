#!/usr/bin/env bash
# Clear the two kinds of state a previous job leaves behind on the persistent
# macOS E2E guest: orphaned Electron process trees, and macOS saved
# application state for the Electron bundle. Report what was found either way.
#
# The macOS Desktop E2E lane runs on a persistent Tart guest, not a fresh VM
# per job, so anything a previous job left behind survives into the next one.
# The E2E fixture's teardown (apps/desktop/e2e/fixtures/electron-app.ts)
# routinely falls back from a graceful close to killProcessTree plus a fixed
# one-second wait, and that wait is not proof of reaping: Electron helper
# processes can outlive the main pid.
#
# Of the two, the saved application state is the one tied to an observed
# failure — see clear_saved_application_state below. The process reap is
# hygiene: a healthy runner starts a job with zero leftovers, so a non-zero
# count is evidence worth surfacing, and starting a job with orphans is wrong
# regardless. Note that force-killing an Electron is itself what creates the
# saved-state trigger, so the reap must not ship without the state clearing.
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
#   * Every pid is re-checked against the scope immediately before it is
#     signalled, so a pid that exits and gets recycled between the scan and
#     the kill cannot be hit by mistake.
#
# Test seams (see macos-e2e-pre-run-cleanup.test.mjs):
#   REAP_PS_SNAPSHOT_FILE  Read the process table from this file instead of
#                          running ps. Forces report-only mode: with an
#                          injected table the script signals nothing.
#   REAP_SELF_PID          Override the pid used for self-exclusion.
#   REAP_STATE_HOME        Look for saved application state under this
#                          directory instead of $HOME, and never touch
#                          cfprefsd defaults. Lets the destructive delete run
#                          against a throwaway tree under test; without it a
#                          report-only run deletes nothing at all.

set -euo pipefail

# Log prefix on every line, so the step's output is greppable in a job log.
LOG="macos-e2e-cleanup"

# The E2E suite runs the unsigned dev Electron binary, whose bundle id is
# com.github.Electron (node_modules/electron/dist/Electron.app). The packaged
# PwrAgent id is not listed: this lane never launches it.
ELECTRON_BUNDLE_IDS=("com.github.Electron")

# `RUNNER_WORKSPACE` is <runner>/_work/<repo>; GITHUB_WORKSPACE is the checkout
# beneath it. Prefer the former so a leftover from a previous job's build
# directory still matches, and refuse to run rather than guess a kill scope.
scope="${RUNNER_WORKSPACE:-${GITHUB_WORKSPACE:-}}"
if [[ -z "$scope" ]]; then
  echo "$LOG: neither RUNNER_WORKSPACE nor GITHUB_WORKSPACE is set;" >&2
  echo "$LOG: refusing to guess a kill scope on a shared machine." >&2
  exit 1
fi
# Anchor the scope with a trailing slash. A bare substring test would also
# match a sibling workspace that merely shares the prefix (`_work/PwrAgent2`
# against a scope of `_work/PwrAgent`).
scope="${scope%/}"
scope_prefix="$scope/"

# Electron main, every helper, and the crashpad handler all carry
# /Electron.app/ in argv[0], because the framework lives inside the bundle and
# the bundle lives under node_modules. That marker plus the scope prefix
# identify exactly this lane's E2E processes.
marker="/Electron.app/"

self_pid="${REAP_SELF_PID:-$$}"
injected_table="${REAP_PS_SNAPSHOT_FILE:-}"

# Spell the template out rather than using `mktemp -t NAME`. BSD mktemp
# appends the X's for you; GNU mktemp treats the argument as the template and
# fails with "too few X's". The script only ever runs for real on macOS, but
# its unit tests run on every platform's Test job.
tmp_root="${TMPDIR:-/tmp}"
tmp_root="${tmp_root%/}"
snapshot_file=$(mktemp "$tmp_root/macos-e2e-cleanup.XXXXXXXX")
matches_file=$(mktemp "$tmp_root/macos-e2e-cleanup-matches.XXXXXXXX")
trap 'rm -f "$snapshot_file" "$matches_file"' EXIT

summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  printf '%s\n' "$1" >>"$GITHUB_STEP_SUMMARY"
}

# Classify the current process table into `$matches_file`. Emits one
# `pid|ppid|state|etime|command` line per in-scope orphan, then a final
# `OUTSIDE_SCOPE|<count>` line for Electron seen elsewhere on the guest.
scan() {
  if [[ -n "$injected_table" ]]; then
    cat "$injected_table" >"$snapshot_file"
  else
    # -ww keeps full argument vectors; the helper processes are identified by
    # the framework path in argv[0], which would otherwise be truncated.
    ps -Awwo pid=,ppid=,state=,etime=,command= >"$snapshot_file"
  fi

  # The marker and the scope both travel through the environment rather than
  # as awk arguments: awk's own command line is in the very table it is
  # classifying, so a marker plus a scope in argv would make awk match itself.
  # The process-tree exclusion below would still catch it, but a self-match is
  # not a thing to leave one guard away from.
  REAP_MARKER="$marker" REAP_SCOPE_PREFIX="$scope_prefix" \
  awk -v self="$self_pid" '
    # True when `pid` sits anywhere beneath this script in the process tree.
    function descends_from_self(pid,   walked) {
      while (pid > 1) {
        if (pid == self) return 1
        if (pid in walked) return 0
        walked[pid] = 1
        if (!(pid in parent)) return 0
        pid = parent[pid]
      }
      return 0
    }
    # The Electron bundle path itself must live under this workspace. Testing
    # the whole command line for the scope would also match a foreign Electron
    # that merely mentions this checkout in an argument, and testing only
    # argv[0] would miss a bundle launched through a wrapper. So: some single
    # argument has to both start with the scope and name the bundle.
    function bundle_under_scope(command,   i, count, token) {
      if (index(command, marker) == 0) return 0
      if (index(command, scope_prefix) == 1) return 1
      count = split(command, token, " ")
      for (i = 1; i <= count; i++) {
        if (index(token[i], scope_prefix) == 1 && index(token[i], marker) > 0) return 1
      }
      return 0
    }
    BEGIN {
      marker = ENVIRON["REAP_MARKER"]
      scope_prefix = ENVIRON["REAP_SCOPE_PREFIX"]
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
      # Ancestors of this script (the step shell, the runner worker, launchd)
      # can never be orphans, and killing one would take down the job. The
      # snapshot covers every process, so walk them straight out of the
      # parent map rather than shelling out per generation.
      for (pid = self; pid > 1 && (pid in parent) && !(pid in ancestor); pid = parent[pid]) {
        ancestor[pid] = 1
      }
      ancestor[self] = 1

      outside = 0
      for (row = 1; row <= rows; row++) {
        if (index(commands[row], marker) == 0) continue
        if (pids[row] in ancestor || descends_from_self(pids[row])) continue
        if (!bundle_under_scope(commands[row])) { outside++; continue }
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
}

# Elapsed time is the correlation handle: it dates a leftover to a specific
# previous job on this runner.
print_orphans() {
  printf '%s\n' "$orphan_lines" | while IFS='|' read -r pid ppid state etime command; do
    printf '  %-7s ppid=%-7s state=%-4s elapsed=%-14s %.200s\n' \
      "$pid" "$ppid" "$state" "$etime" "$command"
  done
}

# A pid captured by a scan can exit before it is signalled, and macOS will
# eventually hand that number to something else. Re-read the command line and
# re-apply both tests, so the signal can only ever land on a process that is
# still an in-scope Electron leftover.
still_in_scope() {
  local pid="$1" command token
  local -a tokens
  command=$(ps -ww -o command= -p "$pid" 2>/dev/null || true)
  [[ -n "$command" ]] || return 1
  [[ "$command" == *"$marker"* ]] || return 1
  [[ "$command" == "$scope_prefix"* ]] && return 0
  # Same rule as the awk classifier: the bundle path, not just any mention of
  # the workspace. `read -a` rather than word splitting so a `*` in a path
  # cannot glob.
  IFS=' ' read -r -a tokens <<<"$command"
  for token in "${tokens[@]}"; do
    if [[ "$token" == "$scope_prefix"* && "$token" == *"$marker"* ]]; then
      return 0
    fi
  done
  return 1
}

# Takes the pid list explicitly rather than reading a caller's variable, so
# what gets signalled is visible at the call site.
signal_orphans() {
  local signal="$1" pid
  shift
  for pid in "$@"; do
    if still_in_scope "$pid"; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

# Reap every in-scope leftover. Returns 1 only when something is still alive
# after two full rounds.
reap_orphans() {
  local round first_count survivors

  if [[ "$orphan_count" -eq 0 ]]; then
    echo "$LOG: nothing to reap; the runner started this job clean."
    summary "### Orphaned Electron check: clean"
    summary ""
    summary "No leftover Electron processes under \`$scope\` before the E2E run."
    summary "(\`$outside_count\` Electron process(es) elsewhere on the guest, left alone.)"
    return 0
  fi

  first_count="$orphan_count"
  echo "$LOG: leftovers (pid, ppid, state, elapsed, command):"
  print_orphans

  echo "::warning title=Orphaned Electron processes on macOS runner::Found $first_count leftover Electron process(es) under $scope before this job's E2E run. A healthy runner starts clean; these came from a previous job whose teardown did not reap its process tree."

  summary "### Orphaned Electron check: $first_count leftover process(es) reaped"
  summary ""
  summary "A healthy runner starts a job with zero leftovers under \`$scope\`."
  summary ""
  summary '```'
  printf '%s\n' "$orphan_lines" | while IFS='|' read -r pid ppid state etime command; do
    summary "$(printf '%-7s ppid=%-7s state=%-4s elapsed=%-14s %.200s' \
      "$pid" "$ppid" "$state" "$etime" "$command")"
  done
  summary '```'

  # Two rounds, because a leftover Electron main can spawn a helper after the
  # scan that captured it. Round two catches that child; anything still
  # standing after it is not losing a race, it is refusing to die.
  local -a orphan_pids
  for round in 1 2; do
    IFS=$'\n' read -r -d '' -a orphan_pids \
      < <(printf '%s\n' "$orphan_lines" | cut -d'|' -f1 && printf '\0')
    if [[ "$round" -gt 1 ]]; then
      echo "$LOG: round $round — $orphan_count still present after round $((round - 1)):"
      print_orphans
    fi

    # TERM first so anything still capable of an orderly exit takes it, then
    # KILL whatever ignored it. Both are best-effort: a pid that exits in
    # between is a success, not an error.
    signal_orphans TERM "${orphan_pids[@]}"
    sleep 2
    signal_orphans KILL "${orphan_pids[@]}"
    sleep 2

    # Re-scan rather than re-checking only the pids just signalled: that is
    # the only way to prove the scope is actually clean, and it also surfaces
    # helpers born after the previous scan.
    scan
    # Not `[[ ... ]] && break`: under `set -e` a false test as the last
    # command in the body would exit the script instead of running round two.
    if [[ "$orphan_count" -eq 0 ]]; then
      break
    fi
  done

  if [[ "$orphan_count" -ne 0 ]]; then
    survivors=$(printf '%s\n' "$orphan_lines" | cut -d'|' -f1 | tr '\n' ' ')
    # SIGKILL is not refusable in user space. A survivor means the process is
    # stuck in the kernel — the vmapple paravirt driver has wedged Electron
    # helpers at birth before — and no amount of retrying here will clear it.
    # Fail now with an actionable message instead of burning the lane's
    # 20-minute cap on a suite that cannot launch a window.
    echo "$LOG: still present after two reap rounds:"
    print_orphans
    echo "::error title=Unkillable Electron processes on macOS runner::pid(s) $survivors survived SIGKILL. The guest is wedged at the kernel level and needs to be recycled before this lane can pass."
    summary ""
    summary "**pid(s) \`$survivors\` survived SIGKILL — recycle the guest.**"
    return 1
  fi

  echo "$LOG: reaped $first_count process(es); a follow-up scan found the scope clean."
  return 0
}

# Clear macOS saved application state for the Electron bundle.
#
# This is the half of the cleanup that addresses an actually-observed failure.
# A runner screenshot caught the AppKit alert "The last time you opened
# Electron, it unexpectedly quit while reopening windows. Do you want to try
# to reopen its windows again?" sitting on the guest. That alert is modal and
# it appears before the app creates any window, which is exactly the
# 2026-08-07 signature: `Launch electron` completes, `Wait for event "window"`
# never returns, 0 tests, full 20-minute cap.
#
# The trigger is an abnormal termination of the same bundle id — precisely
# what the E2E teardown's killProcessTree fallback produces, and what the
# reap above produces too. So the reap alone does not fix this and can even
# feed it; the two have to ship together.
#
# Preferences and saved state for the dev Electron binary are keyed on the
# bundle id under the real user, via cfprefsd. The fixture's per-test `HOME`
# override (apps/desktop/e2e/fixtures/electron-app.ts) does NOT isolate them,
# which is why this state survives from job to job on a persistent guest.
clear_saved_application_state() {
  local bundle_id state_dir state_home

  # `set -u` catches an unset HOME but not an empty one, and an empty one
  # would aim the rm at /Library/Saved Application State. This is the only
  # destructive line in the script; it does not get to run on a guess.
  state_home="${REAP_STATE_HOME:-${HOME:-}}"
  if [[ -z "$state_home" ]]; then
    echo "$LOG: no home directory resolved; leaving saved application state alone." >&2
    return 0
  fi

  for bundle_id in "${ELECTRON_BUNDLE_IDS[@]}"; do
    state_dir="$state_home/Library/Saved Application State/$bundle_id.savedState"
    if [[ -d "$state_dir" ]]; then
      rm -rf "$state_dir"
      echo "$LOG: removed saved application state for $bundle_id"
      echo "::warning title=Stale Electron saved state on macOS runner::Removed $bundle_id.savedState before this job's E2E run. That state is what produces the modal \"unexpectedly quit while reopening windows\" alert, which blocks window creation and makes the suite time out having run 0 tests."
      summary ""
      summary "Removed stale \`$bundle_id.savedState\` (source of the \"reopen windows\" modal)."
    else
      echo "$LOG: no saved application state for $bundle_id"
    fi

    # Belt and braces: tell AppKit not to restore windows for this bundle at
    # all. Deleting the directory removes today's trigger; these two keys stop
    # it being recreated by the next abnormal exit. Scoped to the dev Electron
    # bundle id, idempotent, and reversible with `defaults delete`.
    #
    # CI only, and never under a test state home. These go through cfprefsd,
    # which is keyed on the logged-in user and ignores $HOME, so there is no
    # way to scope them to a throwaway profile — running this script by hand
    # on a workstation, or from the unit tests, would silently change that
    # operator's own Electron behavior. On the runner guest the same user also
    # runs PwrSnap's E2E, which wants this suppressed too.
    if [[ -n "${REAP_STATE_HOME:-}" ]]; then
      echo "$LOG: test state home in use; leaving $bundle_id defaults untouched"
      continue
    fi
    if [[ -z "${GITHUB_ACTIONS:-}" ]]; then
      echo "$LOG: not on GitHub Actions; leaving $bundle_id defaults untouched"
      continue
    fi
    defaults write "$bundle_id" ApplePersistenceIgnoreState -bool true 2>/dev/null || true
    defaults write "$bundle_id" NSQuitAlwaysKeepsWindows -bool false 2>/dev/null || true
  done
}

scan
echo "$LOG: scope        $scope"
echo "$LOG: in scope     $orphan_count orphaned Electron process(es)"
echo "$LOG: out of scope $outside_count Electron process(es) elsewhere on this guest (not touched)"

if [[ -n "$injected_table" ]]; then
  echo "$LOG: report-only (process table injected); nothing was signalled."
  [[ "$orphan_count" -eq 0 ]] || print_orphans
  # The saved-state clearing is the one destructive path here, so it does get
  # exercised under test — but only against an explicitly supplied throwaway
  # home. Without REAP_STATE_HOME a stray report-only run cannot delete the
  # invoking user's real state.
  if [[ -n "${REAP_STATE_HOME:-}" ]]; then
    clear_saved_application_state
  else
    echo "$LOG: report-only; REAP_STATE_HOME unset, saved application state left alone."
  fi
  exit 0
fi

reap_status=0
reap_orphans || reap_status=$?

# After the reap, never before: signalling an Electron can make AppKit write
# fresh saved state on the way out.
clear_saved_application_state

exit "$reap_status"
