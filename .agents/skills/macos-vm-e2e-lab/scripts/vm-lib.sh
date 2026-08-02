#!/usr/bin/env bash
# Shared helpers for PwrAgent's Tart macOS VM lab. Source from the other
# scripts; do not run directly.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAB_ROOT=${PWRAGENT_MAC_VM_LAB_ROOT:-"$HOME/pwragent-mac-vm"}
TART=${TART:-tart}
VM_DEV=${VM_DEV:-pwragent-dev}
VM_BASE=${VM_BASE:-pwragent-sequoia-base}
SSH_KEY=${PWRAGENT_MAC_VM_SSH_KEY:-"$LAB_ROOT/id_ed25519"}
SSH_USER=admin
SSH_OPTS=(
  -i "$SSH_KEY"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
  -o ConnectTimeout=5
)

vm_exists() {
  "$TART" list --format json \
    | /usr/bin/python3 -c "import json,sys; print(any(vm['Name'] == sys.argv[1] for vm in json.load(sys.stdin)))" "$1" \
    | grep -q True
}

vm_running() {
  "$TART" list --format json \
    | /usr/bin/python3 -c "import json,sys; print(any(vm['Name'] == sys.argv[1] and vm.get('State') == 'running' for vm in json.load(sys.stdin)))" "$1" \
    | grep -q True
}

vm_start_headless() {
  local vm=$1
  if vm_running "$vm"; then
    return 0
  fi

  # --vnc-experimental gives the guest a display device; --no-graphics keeps
  # Tart from opening a Screen Sharing window on the host. The guest's real
  # resolution is corrected in-guest by ~/bin/setres.
  echo ">> starting $vm (headless, VNC display)"
  nohup "$TART" run "$vm" --vnc-experimental --no-graphics \
    >"$LAB_ROOT/.$vm.run.log" 2>&1 &
  disown || true
}

vm_wait_ip() {
  local vm=$1
  local tries=${2:-60}
  local ip=""
  for _ in $(seq 1 "$tries"); do
    ip=$("$TART" ip "$vm" 2>/dev/null || true)
    if [[ -n "$ip" ]]; then
      echo "$ip"
      return 0
    fi
    sleep 2
  done
  echo "timed out waiting for $vm IP" >&2
  return 1
}

vm_wait_ssh() {
  local ip=$1
  local tries=${2:-60}
  for _ in $(seq 1 "$tries"); do
    if ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" true 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "timed out waiting for SSH on $ip" >&2
  return 1
}

vm_ssh() {
  local vm=$1
  shift
  local ip
  ip=$(vm_wait_ip "$vm")
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" "$@"
}

# One-time only: cirruslabs images initially expose admin/admin. Install our
# dedicated public key, then all subsequent operations use key auth.
vm_install_key() {
  local vm=$1
  local ip
  ip=$(vm_wait_ip "$vm")
  if [[ ! -f "$SSH_KEY" ]]; then
    ssh-keygen -t ed25519 -N "" -f "$SSH_KEY" -C "pwragent-mac-vm"
  fi
  if ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" true 2>/dev/null; then
    echo ">> key auth already works for $vm"
    return 0
  fi

  local public_key
  public_key=$(<"$SSH_KEY.pub")
  /usr/bin/expect <<EOF
set timeout 30
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null $SSH_USER@$ip "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$public_key' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
expect {
  -re "assword:" { send "admin\r"; exp_continue }
  eof {}
}
EOF
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$ip" true
  echo ">> key installed for $vm"
}
