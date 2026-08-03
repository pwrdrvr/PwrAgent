#!/usr/bin/env bash
# Run PwrAgent's desktop Playwright E2E suite in the PwrAgent dev VM. Electron
# windows render on the guest display, never on the host desktop.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"
source ./vm-lib.sh

LOCAL_REPO=""
LOCAL_RUN=0
if [[ ${1:-} == "--local" ]]; then
  shift
  if [[ $# -gt 0 && -e "$1/.git" ]]; then
    LOCAL_REPO=$(cd "$1" && pwd)
    shift
  else
    LOCAL_REPO=$(pwd)
  fi
  if [[ ! -e "$LOCAL_REPO/.git" ]]; then
    echo "--local requires a Git repository or worktree: $LOCAL_REPO" >&2
    exit 1
  fi
  LOCAL_RUN=1
  BRANCH=e2e-local
else
  BRANCH=${1:?usage: run-e2e.sh <branch> [Playwright args] | --local [repo-path] [Playwright args]}
  shift
fi

EXTRA_ARGS=$(printf '%q ' "$@")
VM=${VM:-$VM_DEV}
vm_start_headless "$VM"
IP=$(vm_wait_ip "$VM")
vm_wait_ssh "$IP"

STAMP=$(date +%Y%m%d-%H%M%S)
LOG="e2e-$STAMP.log"

if [[ $LOCAL_RUN == 1 ]]; then
  echo ">> pushing committed local HEAD from $LOCAL_REPO into VM branch e2e-local"
  # The guest Git repo is an SSH remote, not an LFS server. Skip the LFS
  # pre-push negotiation and copy the exact objects referenced by HEAD into
  # the guest media store before checkout. This keeps --local useful for
  # unpushed visual-golden commits without copying the host's entire LFS cache.
  LFS_MEDIA_DIR=$(git -C "$LOCAL_REPO" lfs env | sed -n 's/^LocalMediaDir=//p')
  LFS_OBJECT_PATHS=()
  while IFS= read -r oid; do
    [[ -n $oid ]] || continue
    object_path="${oid:0:2}/${oid:2:2}/$oid"
    if [[ ! -f "$LFS_MEDIA_DIR/$object_path" ]]; then
      echo "missing local Git LFS object for HEAD: $oid" >&2
      exit 1
    fi
    LFS_OBJECT_PATHS+=("$object_path")
  done < <(git -C "$LOCAL_REPO" lfs ls-files --long HEAD | awk '{print $1}')

  if [[ ${#LFS_OBJECT_PATHS[@]} -gt 0 ]]; then
    echo ">> copying ${#LFS_OBJECT_PATHS[@]} HEAD Git LFS object(s) into the VM"
    tar -C "$LFS_MEDIA_DIR" -cf - "${LFS_OBJECT_PATHS[@]}" \
      | ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
        'mkdir -p "$HOME/PwrAgent/.git/lfs/objects" && tar -C "$HOME/PwrAgent/.git/lfs/objects" -xf -'
  fi

  GIT_LFS_SKIP_PUSH=1 \
    GIT_SSH_COMMAND="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    git -C "$LOCAL_REPO" push -q -f "$SSH_USER@$IP:PwrAgent" HEAD:refs/heads/e2e-local
fi

echo ">> launching E2E for $BRANCH in tmux session e2e on $VM ($IP)"
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  "BRANCH=$(printf %q "$BRANCH") LOCAL_RUN=$(printf %q "$LOCAL_RUN") LOG=$(printf %q "$LOG") EXTRA_ARGS=$(printf %q "$EXTRA_ARGS") bash -s" <<'REMOTE'
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
if tmux has-session -t e2e 2>/dev/null; then
  echo "tmux session e2e already exists; attach with: tmux attach -t e2e" >&2
  exit 2
fi

cat > "$HOME/e2e-pwragent-job.sh" <<'JOB'
#!/usr/bin/env bash
set -euo pipefail
eval "$(/opt/homebrew/bin/brew shellenv)"
[[ -x "$HOME/bin/setres" ]] && "$HOME/bin/setres" || true
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
cd "$HOME/PwrAgent"
if [[ "$LOCAL_RUN" == "1" ]]; then
  git checkout -f --detach e2e-local
else
  git fetch origin --prune
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi
git lfs pull
nvm install >/dev/null
nvm use >/dev/null
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# Tart's AppleParavirtGPU can reset under Electron GPU load. PwrAgent's early
# main-process env gate switches these guest E2E runs to software rendering.
export PWRAGENT_E2E_DISABLE_GPU=1
eval "set -- $EXTRA_ARGS"
# Invoke the package lifecycle explicitly, then use Playwright directly. The
# `pnpm --filter … test:e2e -- <args>` form forwards a literal `--` to
# Playwright and causes a requested spec path to be ignored.
pnpm --filter @pwragent/desktop pretest:e2e
cd apps/desktop
pnpm exec playwright test -c playwright.config.ts "$@"
JOB
chmod +x "$HOME/e2e-pwragent-job.sh"
tmux new-session -d -s e2e \
  "bash -c 'set -o pipefail; ~/e2e-pwragent-job.sh 2>&1 | tee ~/$LOG; echo \$? > ~/$LOG.exit'"
echo ">> started; log: ~/$LOG"
REMOTE

echo ">> tailing log (Ctrl-C detaches; the VM test continues in tmux)"
RC=0
ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" \
  "touch ~/$LOG; tail -f ~/$LOG & tail_pid=\$!; while [[ ! -f ~/$LOG.exit ]]; do sleep 2; done; sleep 1; kill \$tail_pid 2>/dev/null; exit \$(cat ~/$LOG.exit)" \
  || RC=$?

echo ">> E2E exited with code $RC"
if [[ $RC -ne 0 ]]; then
  echo ">> fetching Playwright artifacts"
  mkdir -p "$LAB_ROOT/artifacts/$STAMP"
  scp -r "${SSH_OPTS[@]}" "$SSH_USER@$IP:~/PwrAgent/apps/desktop/test-results" "$LAB_ROOT/artifacts/$STAMP/" 2>/dev/null || true
  scp -r "${SSH_OPTS[@]}" "$SSH_USER@$IP:~/PwrAgent/apps/desktop/playwright-report" "$LAB_ROOT/artifacts/$STAMP/" 2>/dev/null || true
  echo ">> artifacts: $LAB_ROOT/artifacts/$STAMP"
fi
exit "$RC"
