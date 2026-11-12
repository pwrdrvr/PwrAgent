#!/bin/sh
# Install a project's dependencies for a contained Outpost from a short-lived helper
# container that has network. No agent runs in the helper; it exits when the install ends.
#
# The helper uses the Outpost's own image, volume, user, HOME and PWRAGENT_HOME, so the
# pnpm store, corepack's pnpm, the Electron download and the Git runtime cache all land
# on the volume. Inside the Outpost a plain `pnpm install` then works offline, in any
# checkout or worktree, with its own node_modules hard-linked from the store.
#
# Usage: deps-helper.sh [project-name] [install|fetch]
#   OUTPOST_CONTAINER   default pwragent-outpost
#   install (default) runs a frozen-lockfile install in the checkout, build scripts included.
#   fetch only fills the store from the lockfile; use it after a lockfile change.
set -eu
name="${1:-PwrAgnt}"
mode="${2:-install}"
case "$name" in *[!A-Za-z0-9._-]*|.*) echo "bad project name: $name" >&2; exit 2;; esac
case "$mode" in install|fetch) ;; *) echo "mode must be install or fetch" >&2; exit 2;; esac
container="${OUTPOST_CONTAINER:-pwragent-outpost}"
image="$(docker inspect -f '{{.Config.Image}}' "$container")"
user="$(docker inspect -f '{{.Config.User}}' "$container")"
volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/outpost"}}{{.Name}}{{end}}{{end}}' "$container")"
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -n "s/^$1=//p"; }
home="$(env_of HOME)"; pwragent_home="$(env_of PWRAGENT_HOME)"
[ -n "$volume" ] && [ -n "$home" ] || { echo "cannot read the Outpost's volume or HOME from $container" >&2; exit 1; }

docker run --rm --name "$container-deps" --user "${user:-501:20}" \
  -e HOME="$home" -e PWRAGENT_HOME="$pwragent_home" -e CI=true \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e PWRGIT_RUNTIME_CACHE="$home/.cache/pwrgit-runtime-cache" \
  -v "$volume:/home/outpost" -w "/home/outpost/workspace/$name" \
  --entrypoint sh "$image" -c '
    set -eu
    mkdir -p "$HOME/.local/bin"
    corepack enable --install-directory "$HOME/.local/bin"
    export PATH="$HOME/.local/bin:$PATH"
    echo "pnpm $(pnpm --version), store $(pnpm store path)"
    if [ "$1" = fetch ]; then pnpm fetch; else pnpm install --frozen-lockfile; fi
    # PwrAgent: the pwragent package build, which its tests run, downloads a pinned Git runtime.
    if [ "$1" = install ] && [ -f packages/pwragent/scripts/build.mjs ]; then node packages/pwragent/scripts/build.mjs; fi
  ' _ "$mode"

# Login shells inside the Outpost (Codex runs `bash -lc`) find pnpm, never try the network
# for it, and reuse the cached Git runtime.
docker exec -i "$container" sh -c 'f="$HOME/.profile"; grep -qs "PWRGIT_RUNTIME_CACHE" "$f" || cat >> "$f"' <<'EOF'
# outpost-deps: pnpm via corepack shims installed by the deps helper
export PATH="$HOME/.local/bin:$PATH"
export COREPACK_ENABLE_NETWORK=0
export PWRGIT_RUNTIME_CACHE="$HOME/.cache/pwrgit-runtime-cache"
EOF
echo "Dependencies ready for $name"
