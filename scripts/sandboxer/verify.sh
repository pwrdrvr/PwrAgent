#!/usr/bin/env bash
# Runs PwrAgent's Linux CI checks inside a Sandboxer sandbox (Ubuntu).
# The procedure and the transfer steps are in
# .agents/skills/sandboxer-verification/SKILL.md.
#
#   scripts/sandboxer/verify.sh setup        Node from .nvmrc, pnpm, E2E packages, pnpm install
#   scripts/sandboxer/verify.sh unit [args]  pnpm test [args]
#   scripts/sandboxer/verify.sh lint         pnpm lint (the CI Lint job; stops at the first failure)
#   scripts/sandboxer/verify.sh e2e [--lanes N] [args]
#                                            Linux desktop E2E under Xvfb + Openbox, as CI runs it;
#                                            --lanes splits it into N concurrent shards
#   scripts/sandboxer/verify.sh all          setup, lint, unit, e2e --lanes 2; runs every step
#
# Each step writes .local/sandboxer/<step>.log and appends
# "<step> exit=<code> secs=<seconds>" to .local/sandboxer/status.
# A step longer than the sandbox exec limit must run under nohup; poll status.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root" || exit 1
out_dir="$repo_root/.local/sandboxer"
mkdir -p "$out_dir"

node_version="$(tr -d '[:space:]' < .nvmrc)"
node_dir="/opt/node-$node_version"
export PATH="$node_dir/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Sandboxer passes the account's GitHub token into the VM. CI checks run
# without one, and no check needs it.
unset GH_TOKEN GITHUB_TOKEN

setup() {
  if [[ "$(node -v 2>/dev/null)" != "$node_version" ]]; then
    local archive="node-$node_version-linux-x64.tar.xz"
    curl -fsSL "https://nodejs.org/dist/$node_version/$archive" -o "/tmp/$archive" || return 1
    sudo mkdir -p "$node_dir" || return 1
    sudo tar -xJf "/tmp/$archive" -C "$node_dir" --strip-components=1 || return 1
  fi
  sudo "$node_dir/bin/corepack" enable --install-directory "$node_dir/bin" || return 1
  if ! command -v openbox >/dev/null || ! command -v xprop >/dev/null; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq || return 1
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -qq --no-install-recommends -y \
      openbox x11-utils xvfb || return 1
  fi
  node -v && pnpm -v && pnpm install --frozen-lockfile
}

e2e() {
  # Same display, window manager, and Playwright CI mode as the CI "Linux
  # Desktop E2E" lanes. CI mode retries a failed test once, reports it as
  # flaky, and keeps failure screenshots and videos.
  CI="${CI:-1}" xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24 -noreset" \
    bash .github/scripts/run-linux-desktop-e2e.sh "$@"
}

# Playwright writes test-results/ and .local/ at fixed paths in the checkout,
# so each lane after the first runs in a sibling worktree at the same commit.
# Each lane has its own Xvfb display.
e2e_lanes() {
  local lanes="$1"
  shift
  if ! [[ "$lanes" =~ ^[1-9][0-9]*$ ]]; then
    echo "--lanes needs a positive number" >&2
    return 2
  fi
  if ((lanes == 1)); then
    e2e "$@"
    return
  fi
  local head
  head="$(git rev-parse HEAD)" || return 1
  local lane dir
  local pids=()
  for ((lane = 1; lane <= lanes; lane++)); do
    dir="$repo_root"
    if ((lane > 1)); then
      dir="$repo_root-lane$lane"
      if [[ ! -d "$dir" ]]; then
        git worktree add -q --detach "$dir" "$head" || return 1
      fi
      git -C "$dir" checkout -q --detach "$head" || return 1
      (cd "$dir" && pnpm install --frozen-lockfile) \
        > "$out_dir/e2e-lane$lane-setup.log" 2>&1 || return 1
    fi
    (cd "$dir" && e2e --shard="$lane/$lanes" "$@") > "$out_dir/e2e-lane$lane.log" 2>&1 &
    pids+=("$!")
  done
  local failed=0
  for ((lane = 1; lane <= lanes; lane++)); do
    wait "${pids[lane - 1]}"
    local code=$?
    echo "lane $lane/$lanes exit=$code log=$out_dir/e2e-lane$lane.log"
    ((code == 0)) || failed=1
  done
  return "$failed"
}

run_step() {
  local step="$1"
  shift
  local log="$out_dir/$step.log"
  local start
  start="$(date +%s)"
  case "$step" in
    setup) setup ;;
    unit) pnpm test "$@" ;;
    lint) pnpm lint ;;
    e2e)
      if [[ "${1:-}" == "--lanes" ]]; then
        shift
        local lanes="${1:-}"
        [[ $# -gt 0 ]] && shift
        e2e_lanes "$lanes" "$@"
      else
        e2e "$@"
      fi
      ;;
  esac > "$log" 2>&1
  local code=$?
  echo "$step exit=$code secs=$(( $(date +%s) - start ))" | tee -a "$out_dir/status"
  return "$code"
}

step="${1:-}"
[[ $# -gt 0 ]] && shift
case "$step" in
  setup | unit | lint | e2e)
    run_step "$step" "$@"
    ;;
  all)
    : > "$out_dir/status"
    run_step setup || exit 1
    failed=0
    run_step lint || failed=1
    run_step unit || failed=1
    run_step e2e --lanes 2 || failed=1
    echo "all exit=$failed" | tee -a "$out_dir/status"
    exit "$failed"
    ;;
  *)
    sed -n '2,16p' "$0" >&2
    exit 2
    ;;
esac
