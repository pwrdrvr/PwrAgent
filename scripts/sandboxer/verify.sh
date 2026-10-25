#!/usr/bin/env bash
# Runs PwrAgent's Linux CI checks inside a Sandboxer sandbox (Ubuntu).
# The procedure and the transfer steps are in
# .agents/skills/sandboxer-verification/SKILL.md.
#
#   scripts/sandboxer/verify.sh setup        Node from .nvmrc, pnpm, E2E packages, pnpm install
#   scripts/sandboxer/verify.sh unit [args]  pnpm test [args]
#   scripts/sandboxer/verify.sh lint         pnpm lint (the CI Lint job; stops at the first failure)
#   scripts/sandboxer/verify.sh e2e [args]   Linux desktop E2E under Xvfb + Openbox, as CI runs it
#   scripts/sandboxer/verify.sh all          setup, lint, unit, e2e; runs every step
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
  # Same display and window manager as the CI "Linux Desktop E2E" lanes.
  xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24 -noreset" \
    bash .github/scripts/run-linux-desktop-e2e.sh "$@"
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
    e2e) e2e "$@" ;;
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
    run_step e2e || failed=1
    echo "all exit=$failed" | tee -a "$out_dir/status"
    exit "$failed"
    ;;
  *)
    sed -n '2,15p' "$0" >&2
    exit 2
    ;;
esac
