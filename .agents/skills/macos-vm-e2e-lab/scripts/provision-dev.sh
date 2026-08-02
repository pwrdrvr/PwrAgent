#!/usr/bin/env bash
# Create and provision PwrAgent's interactive dev/test VM from the pristine
# Tart base image. Safe to re-run after partial provisioning failures.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"
source ./vm-lib.sh

VM=${1:-$VM_DEV}
REPOSITORY_URL=${PWRAGENT_MAC_VM_REPOSITORY_URL:-https://github.com/pwrdrvr/PwrAgent.git}

if ! vm_exists "$VM"; then
  echo ">> cloning $VM_BASE -> $VM"
  "$TART" clone "$VM_BASE" "$VM"
  # Comfortable for build + headed Electron E2E. The guest needs a 1440x900+
  # visible frame for layout-sensitive desktop tests.
  "$TART" set "$VM" --cpu 8 --memory 16384 --display 1920x1080
fi

vm_start_headless "$VM"
IP=$(vm_wait_ip "$VM")
echo ">> $VM is at $IP"
vm_install_key "$VM"
vm_wait_ssh "$IP"

echo ">> provisioning inside VM"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  "REPOSITORY_URL=$(printf %q "$REPOSITORY_URL") bash -s" <<'PROVISION'
set -euo pipefail
export NONINTERACTIVE=1
eval "$(/opt/homebrew/bin/brew shellenv)"

xcode-select -p >/dev/null 2>&1 || {
  echo "Xcode Command Line Tools are missing; install them before provisioning." >&2
  exit 1
}

if ! command -v tmux >/dev/null 2>&1; then
  brew install tmux </dev/null
fi
if ! command -v git-lfs >/dev/null 2>&1; then
  brew install git-lfs </dev/null
fi

# Headless Virtualization.framework guests can boot at 1024x768 even when
# Tart's display setting is 1920x1080. Select the guest mode directly at each
# Aqua login so Electron gets a stable viewport.
if [[ ! -x "$HOME/bin/setres" ]]; then
  mkdir -p "$HOME/bin"
  cat > /tmp/pwragent-setres.swift <<'SWIFT'
import CoreGraphics
let display = CGMainDisplayID()
let modes = CGDisplayCopyAllDisplayModes(display, nil) as! [CGDisplayMode]
guard let mode = modes.first(where: { $0.width == 1920 && $0.height == 1080 }) else {
  fputs("setres: no 1920x1080 mode available\n", stderr)
  exit(1)
}
var configuration: CGDisplayConfigRef?
CGBeginDisplayConfiguration(&configuration)
CGConfigureDisplayWithDisplayMode(configuration, display, mode, nil)
exit(CGCompleteDisplayConfiguration(configuration, .permanently) == .success ? 0 : 2)
SWIFT
  swiftc -O /tmp/pwragent-setres.swift -o "$HOME/bin/setres"
fi
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/com.pwragent.setres.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pwragent.setres</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/setres</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict></plist>
PLIST
"$HOME/bin/setres" || true

export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  mkdir -p "$NVM_DIR"
  curl -fsSLo /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh
  bash /tmp/nvm-install.sh </dev/null
fi
source "$NVM_DIR/nvm.sh"

if [[ ! -d "$HOME/PwrAgent/.git" ]]; then
  git clone "$REPOSITORY_URL" "$HOME/PwrAgent" </dev/null
fi
cd "$HOME/PwrAgent"
git fetch origin --prune </dev/null

NODE_VERSION=$(tr -d '[:space:]' < .nvmrc)
nvm install "$NODE_VERSION" </dev/null >/dev/null
nvm alias default "$NODE_VERSION" >/dev/null
nvm use "$NODE_VERSION" >/dev/null
corepack enable >/dev/null 2>&1 || true

echo "== node: $(node -v)"
echo "== pnpm: $(corepack pnpm --version 2>/dev/null || echo pending)"
echo "== provision complete"
PROVISION

echo ">> done. Run ./run-e2e.sh <branch> [Playwright args]"
echo ">> interactive shell: ssh -i $SSH_KEY $SSH_USER@$IP"
