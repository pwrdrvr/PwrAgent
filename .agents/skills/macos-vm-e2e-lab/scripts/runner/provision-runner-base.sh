#!/usr/bin/env bash
# Build the unregistered base image for PwrAgent GitHub Actions runner VMs.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$SCRIPT_DIR"
source ./vm-lib.sh

RUNNER_VM=pwragent-runner-base
RUNNER_VERSION=${1:-}

if ! vm_exists "$RUNNER_VM"; then
  if ! vm_exists "$VM_DEV"; then
    echo "$VM_DEV does not exist; run ./provision-dev.sh first" >&2
    exit 1
  fi
  if vm_running "$VM_DEV"; then
    echo "stop $VM_DEV before cloning it: tart stop $VM_DEV" >&2
    exit 1
  fi
  echo ">> cloning $VM_DEV -> $RUNNER_VM"
  "$TART" clone "$VM_DEV" "$RUNNER_VM"
  "$TART" set "$RUNNER_VM" --cpu 8 --memory 16384 --display 1920x1080
fi

vm_start_headless "$RUNNER_VM"
IP=$(vm_wait_ip "$RUNNER_VM")
vm_wait_ssh "$IP"

echo ">> staging GitHub Actions runner inside $RUNNER_VM"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  "RUNNER_VERSION=$(printf %q "$RUNNER_VERSION") bash -s" <<'REMOTE'
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
if ! command -v git-lfs >/dev/null 2>&1; then
  brew install git-lfs </dev/null
fi
git lfs install >/dev/null
if [[ -z "$RUNNER_VERSION" ]]; then
  RUNNER_VERSION=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['tag_name'].lstrip('v'))")
fi
echo "== actions/runner v$RUNNER_VERSION"
mkdir -p "$HOME/actions-runner"
cd "$HOME/actions-runner"
if [[ ! -f ./run.sh ]]; then
  curl -fsSLo runner.tar.gz "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz"
  tar xzf runner.tar.gz
  rm runner.tar.gz
fi
./config.sh --version || true
echo "== runner staged but not registered"
REMOTE

echo ">> stopping $RUNNER_VM; base images should remain at rest"
"$TART" stop "$RUNNER_VM" || true
