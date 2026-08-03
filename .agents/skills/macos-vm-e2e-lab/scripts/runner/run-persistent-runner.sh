#!/usr/bin/env bash
# Serve PwrAgent and PwrSnap GitHub Actions jobs from one persistent,
# softnet-isolated organization runner. It keeps Node/pnpm/work caches warm,
# but never accepts fork PRs because both workflow-level guards exclude them.

set -euo pipefail

RUNNER_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$RUNNER_SCRIPT_DIR/.."
source ./vm-lib.sh

ORGANIZATION=pwrdrvr
RUNNER_GROUP="PwrDrvr macOS"
BASE=pwragent-runner-base
VM=pwragent-runner
LABELS="pwrdrvr-macos"
RUNNER_NAME="$(hostname -s)-pwrdrvr-macos-runner"

if ! vm_exists "$VM"; then
  if ! vm_exists "$BASE"; then
    echo "$BASE does not exist; run ./runner/provision-runner-base.sh first" >&2
    exit 1
  fi
  echo ">> cloning $BASE -> $VM"
  "$TART" clone "$BASE" "$VM"
fi

if ! vm_running "$VM"; then
  echo ">> booting $VM with softnet isolation"
  nohup "$TART" run "$VM" --vnc-experimental --no-graphics --net-softnet \
    >"$LAB_ROOT/.$VM.run.log" 2>&1 &
  disown || true
fi

IP=$(vm_wait_ip "$VM")
vm_wait_ssh "$IP"

echo ">> verifying $VM has Internet but cannot reach private network space"
if ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  "curl -m 5 -so /dev/null http://192.168.1.1 || nc -z -G 3 10.0.0.1 22" 2>/dev/null; then
  echo "$VM can reach private network space; do not register it" >&2
  exit 1
fi
if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "curl -m 10 -so /dev/null https://api.github.com"; then
  echo "$VM has no Internet access; do not register it" >&2
  exit 1
fi

REGISTERED_URL=$(ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" 'python3 - <<'"'"'PY'"'"'
import json
from pathlib import Path
path = Path.home() / "actions-runner" / ".runner"
if path.exists():
    print(json.loads(path.read_text(encoding="utf-8-sig")).get("gitHubUrl", ""))
PY')
if [[ -n "$REGISTERED_URL" && "$REGISTERED_URL" != "https://github.com/$ORGANIZATION" ]]; then
  echo "$VM is registered to $REGISTERED_URL, not the shared organization runner group." >&2
  exit 2
fi
if [[ -z "$REGISTERED_URL" ]]; then
  # Group administration is needed only for a first registration or a
  # re-baselined VM. Normal launchd restarts retain the local org registration
  # and can run without the broad admin:org token scope.
  "$RUNNER_SCRIPT_DIR/configure-shared-runner-group.sh"
  echo ">> registering shared persistent runner $RUNNER_NAME"
  TOKEN=$(gh api -X POST "orgs/$ORGANIZATION/actions/runners/registration-token" -q .token)
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
    "TOKEN=$(printf %q "$TOKEN") NAME=$(printf %q "$RUNNER_NAME") LABELS=$(printf %q "$LABELS") RUNNER_GROUP=$(printf %q "$RUNNER_GROUP") bash -s" <<'REMOTE'
set -euo pipefail
# actions-runner snapshots PATH in .path during config.sh. Homebrew supplies
# git-lfs, which actions/checkout needs before any job step can repair PATH.
eval "$(/opt/homebrew/bin/brew shellenv)"
cd "$HOME/actions-runner"
./config.sh --unattended \
  --url https://github.com/pwrdrvr \
  --token "$TOKEN" \
  --name "$NAME" \
  --runnergroup "$RUNNER_GROUP" \
  --labels "$LABELS" \
  --replace
REMOTE
else
  echo ">> $VM is already registered to the shared organization"
fi

echo ">> serving one PwrAgent job at a time; Ctrl-C stops listener, not VM"
# launchd preserves the Tart process group so a service reload does not shut
# down the VM. That can leave a detached SSH-backed Runner.Listener behind;
# remove it before this service establishes its single listener.
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  'pkill -f "[R]unner.Listener" 2>/dev/null || true'
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  'eval "$(/opt/homebrew/bin/brew shellenv)"; echo "$PATH" > ~/actions-runner/.path; cd ~/actions-runner && ./run.sh'
