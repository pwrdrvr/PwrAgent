#!/usr/bin/env bash
# Run one macOS Desktop E2E lane so that cancelling the job cannot crash the
# lane's Electron. Usage: macos-e2e-run-lane.sh <command> [args...]
#
# Why this exists. On 2026-10-23 and 2026-10-27, cancelled lanes left the
# dev Electron segfaulting on the persistent runner guests. ReportCrash then
# held a "quit unexpectedly" dialog up for hours, and that dialog holds macOS
# activation (see dismiss_electron_crash_dialogs in
# macos-e2e-pre-run-cleanup.sh). Each crash report is a null dereference on
# the main thread in the copy callback of a DevTools screenshot:
#
#   content::protocol::PageHandler::ScreenshotCaptured  page_handler.cc:1833
#     or the retry in RenderWidgetHostImpl::OnSnapshotFromSurfaceReceived
#   content::DelegatedFrameHost::CopyFromCompositingSurface callback
#
# A Playwright screenshot (`Page.captureScreenshot` with a clip) was pending
# when the renderer died. Chromium 152, which Electron 44 ships, then uses
# the renderer's destroyed view. Chromium fixed both uses in
# https://chromium-review.googlesource.com/c/chromium/src/+/8485185
# (crbug.com/567321049, Chromium 158). No stable Electron has it yet.
# SIGKILLing the renderer while screenshots run reproduces the crash on a
# hosted macOS runner.
#
# The cancellation set that up in two steps:
#   1. GitHub SIGINTs the step. pnpm exits at once, so the step ended while
#      Playwright was still taking the interrupted test's failure screenshot.
#   2. Within about two seconds, "Cleaning up orphan processes" SIGKILLs the
#      processes the job started, newest pid first. That order kills
#      Electron's renderer before Electron's main. In the three reports
#      checked, the main crashed within 0.1s of the runner's kill and before
#      the runner reached it.
#
# So this wrapper:
#   * runs the command in its own process group, forwards SIGINT to it, and
#     keeps the step alive until that whole group exits. Playwright then
#     finishes its interrupted test, screenshot included, and closes Electron
#     itself before the runner reaps anything.
#   * on SIGTERM, which the runner sends 7.5s after SIGINT, SIGKILLs this
#     lane's Electron main processes first and its other Electron processes
#     second. A SIGKILLed main runs no more code, so it cannot crash, and the
#     pre-run cleanup already clears the saved state that a force-kill leaves.
#
# Run it with `exec` from the step, so the runner's signals reach this
# script whether the runner signals the step's pid or its process group.
#
# Scope, because the guest is shared: only Electron whose bundle lives under
# this runner's RUNNER_WORKSPACE is signalled, by the same rule as
# macos-e2e-pre-run-cleanup.sh.

set -uo pipefail

LOG="macos-e2e-run-lane"

if [[ $# -eq 0 ]]; then
  echo "$LOG: usage: macos-e2e-run-lane.sh <command> [args...]" >&2
  exit 2
fi

scope="${RUNNER_WORKSPACE:-${GITHUB_WORKSPACE:-}}"
if [[ -z "$scope" ]]; then
  echo "$LOG: neither RUNNER_WORKSPACE nor GITHUB_WORKSPACE is set;" >&2
  echo "$LOG: refusing to guess a kill scope on a shared machine." >&2
  exit 2
fi
scope_prefix="${scope%/}/"

# Print this lane's Electron pids of one kind: `main` for the main process,
# `other` for helpers and crashpad. Some single argument must both start with
# the scope and name the bundle. The marker and scope travel through the
# environment so awk cannot match its own command line.
lane_electron_pids() {
  ps -Awwo pid=,command= \
    | LANE_KIND="$1" LANE_SCOPE_PREFIX="$scope_prefix" awk '
      BEGIN {
        kind = ENVIRON["LANE_KIND"]
        prefix = ENVIRON["LANE_SCOPE_PREFIX"]
        marker = "/Electron.app/"
        main_suffix = "/Electron.app/Contents/MacOS/Electron"
      }
      {
        in_scope = 0
        is_main = 0
        for (i = 2; i <= NF; i++) {
          if (index($i, prefix) != 1 || index($i, marker) == 0) continue
          in_scope = 1
          tail = substr($i, length($i) - length(main_suffix) + 1)
          if (tail == main_suffix) is_main = 1
        }
        if (!in_scope) next
        if ((kind == "main") == is_main) print $1
      }
    ' \
    | tr '\n' ' '
}

kill_lane_electron() {
  local mains others
  mains=$(lane_electron_pids main)
  if [[ -n "${mains// /}" ]]; then
    echo "$LOG: SIGKILL Electron main pid(s) $mains"
    # Word splitting is the point: one pid per argument.
    # shellcheck disable=SC2086
    kill -KILL $mains 2>/dev/null || true
  fi
  others=$(lane_electron_pids other)
  if [[ -n "${others// /}" ]]; then
    echo "$LOG: SIGKILL Electron helper pid(s) $others"
    # shellcheck disable=SC2086
    kill -KILL $others 2>/dev/null || true
  fi
}

group_alive() {
  kill -0 -- "-$child" 2>/dev/null
}

interrupted=0
terminated=0

on_interrupt() {
  interrupted=1
  echo "$LOG: SIGINT; letting Playwright finish the interrupted test"
  kill -INT -- "-$child" 2>/dev/null || true
}

on_terminate() {
  terminated=1
  echo "$LOG: SIGTERM; stopping this lane's Electron before the runner reaps it"
  kill_lane_electron
  kill -KILL -- "-$child" 2>/dev/null || true
}

trap on_interrupt INT
trap on_terminate TERM

# setpgrp makes the command a process-group leader, so the group outlives an
# early exit of the command itself (pnpm) while Playwright is still running.
# Bash starts a background job with SIGINT and SIGQUIT ignored, and a process
# cannot trap a signal that was ignored when it started, so restore both.
perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; setpgrp(0, 0); exec @ARGV or die "exec $ARGV[0]: $!\n"' -- "$@" &
child=$!

# A trapped signal interrupts `wait`, so wait again until the child is gone.
status=0
while :; do
  wait "$child"
  status=$?
  kill -0 "$child" 2>/dev/null || break
done

# Only a cancellation waits for the rest of the group. A normal run ends when
# the command does, as it did before this wrapper, so a process that lingers
# in the group cannot hold a finished lane open.
while [[ "$interrupted" -eq 1 && "$terminated" -eq 0 ]] && group_alive; do
  sleep 0.2
done

if [[ "$terminated" -eq 1 ]]; then
  exit 143
fi
if [[ "$interrupted" -eq 1 ]]; then
  # Playwright closed what it launched; anything left would be reaped by the
  # runner, renderer first.
  kill_lane_electron
fi
exit "$status"
