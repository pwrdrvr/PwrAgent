#!/usr/bin/env bash
# Serve one PwrAgent or PwrSnap Actions job per fresh, softnet-isolated VM.
# Use when a clean VM per job matters more than warm caches.

set -euo pipefail

RUNNER_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$RUNNER_SCRIPT_DIR/.."
source ./vm-lib.sh

ORGANIZATION=pwrdrvr
RUNNER_GROUP="PwrDrvr macOS"
BASE=pwragent-runner-base
LABELS="pwrdrvr-macos"
ONCE=${1:-}

"$RUNNER_SCRIPT_DIR/configure-shared-runner-group.sh"

serve_one_job() {
  local vm="pwragent-runner-$(date +%s)"
  local result=0

  echo ">> cloning $BASE -> $vm"
  "$TART" clone "$BASE" "$vm"
  cleanup() {
    echo ">> destroying $vm"
    "$TART" stop "$vm" 2>/dev/null || true
    "$TART" delete "$vm" 2>/dev/null || true
  }
  trap cleanup RETURN

  echo ">> booting $vm with softnet isolation"
  nohup "$TART" run "$vm" --vnc-experimental --no-graphics --net-softnet \
    >"$LAB_ROOT/.$vm.run.log" 2>&1 &
  disown || true

  local ip
  ip=$(vm_wait_ip "$vm") || return 1
  vm_wait_ssh "$ip" || return 1

  echo ">> verifying isolation"
  if ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" \
    "curl -m 5 -so /dev/null http://192.168.1.1 || nc -z -G 3 10.0.0.1 22" 2>/dev/null; then
    echo "$vm can reach private network space; do not register it" >&2
    return 1
  fi
  if ! ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" "curl -m 10 -so /dev/null https://api.github.com"; then
    echo "$vm has no Internet access; do not register it" >&2
    return 1
  fi

  TOKEN=$(gh api -X POST "orgs/$ORGANIZATION/actions/runners/registration-token" -q .token)
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" \
    "TOKEN=$(printf %q "$TOKEN") NAME=$(printf %q "$vm") LABELS=$(printf %q "$LABELS") RUNNER_GROUP=$(printf %q "$RUNNER_GROUP") bash -s" <<'REMOTE' || result=$?
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
cd "$HOME/actions-runner"
./config.sh --unattended --ephemeral \
  --url https://github.com/pwrdrvr \
  --token "$TOKEN" \
  --name "$NAME" \
  --runnergroup "$RUNNER_GROUP" \
  --labels "$LABELS" \
  --replace
./run.sh
REMOTE

  echo ">> $vm finished (runner exit $result)"
}

while true; do
  serve_one_job || {
    echo ">> runner cycle failed; retrying in 30 seconds" >&2
    sleep 30
  }
  [[ "$ONCE" == "--once" ]] && break
done
