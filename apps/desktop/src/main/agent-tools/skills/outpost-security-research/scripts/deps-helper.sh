#!/bin/sh
# Install a project's dependencies for a contained Outpost from a short-lived helper
# container that has network. No agent runs in the helper; it exits when the install ends.
#
# The helper has network and the Outpost's whole volume, so it runs nothing from the
# Outpost's checkouts: an agent can edit those (package.json, lockfile, .pnpmfile.cjs,
# build scripts). It installs from a `git archive` of a commit in your own repository,
# unpacked into a scratch folder on the volume that agents cannot write, and removed after.
#
# The helper uses the Outpost's own image, volume, user, HOME and PWRAGENT_HOME, so the
# pnpm store, corepack's pnpm, the Electron download and the Git runtime cache all land
# on the volume. Inside the Outpost a plain `pnpm install` then works offline, in any
# checkout or worktree, with its own node_modules hard-linked from the store.
#
# pnpm runs through the image's root-owned corepack shims. An image built before it had
# them gets shims in ~/.local/bin on the volume instead.
#
# Usage: deps-helper.sh <local-repo> [install|fetch]
#   OUTPOST_CONTAINER   default pwragent-outpost
#   OUTPOST_DEPS_REF    the commit to install from, default HEAD; use the one you pushed
#   install (default) runs a frozen-lockfile install, build scripts included.
#   fetch only fills the store from the lockfile; use it after a lockfile change.
#
# On an Outpost that allows Full Access an agent can also change the caches this runs
# (corepack's pnpm, and on an older image the shims in ~/.local/bin). Do not run the
# helper on one.
set -eu
repo="$(cd "$1" && git rev-parse --show-toplevel)"
mode="${2:-install}"
ref="${OUTPOST_DEPS_REF:-HEAD}"
case "$mode" in install|fetch) ;; *) echo "mode must be install or fetch" >&2; exit 2;; esac
git -C "$repo" rev-parse --verify -q "$ref^{commit}" >/dev/null || { echo "unknown commit: $ref" >&2; exit 2; }
container="${OUTPOST_CONTAINER:-pwragent-outpost}"
image="$(docker inspect -f '{{.Config.Image}}' "$container")"
user="$(docker inspect -f '{{.Config.User}}' "$container")"
volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/outpost"}}{{.Name}}{{end}}{{end}}' "$container")"
env_of() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -n "s/^$1=//p"; }
home="$(env_of HOME)"; pwragent_home="$(env_of PWRAGENT_HOME)"
[ -n "$volume" ] && [ -n "$home" ] || { echo "cannot read the Outpost's volume or HOME from $container" >&2; exit 1; }

git -C "$repo" archive --format=tar "$ref" | docker run -i --rm --name "$container-deps" --user "${user:-501:20}" \
  -e HOME="$home" -e PWRAGENT_HOME="$pwragent_home" -e CI=true \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e PWRGIT_RUNTIME_CACHE="$home/.cache/pwrgit-runtime-cache" \
  -v "$volume:/home/outpost" \
  --entrypoint sh "$image" -c '
    set -eu
    # Beside the store, so pnpm hard-links; outside every workspace an agent can write.
    stage="$HOME/.cache/outpost-deps/stage"
    rm -rf "$stage"
    mkdir -p "$stage"
    trap "rm -rf \"$stage\"" EXIT
    tar -x -C "$stage" -f -
    cd "$stage"
    if [ -e /usr/local/bin/pnpm ]; then
      # Shims an earlier run left on the volume would come first on PATH in the Outpost.
      rm -f "$HOME/.local/bin/pnpm" "$HOME/.local/bin/pnpx"
    else
      mkdir -p "$HOME/.local/bin"
      corepack enable --install-directory "$HOME/.local/bin"
      export PATH="$HOME/.local/bin:$PATH"
    fi
    echo "pnpm $(pnpm --version), store $(pnpm store path)"
    if [ "$1" = fetch ]; then pnpm fetch; else pnpm install --frozen-lockfile; fi
    # PwrAgent: the pwragent package build, which its tests run, downloads a pinned Git runtime.
    if [ "$1" = install ] && [ -f packages/pwragent/scripts/build.mjs ]; then node packages/pwragent/scripts/build.mjs; fi
  ' _ "$mode"

# Login shells inside the Outpost (Codex runs `bash -lc`) find pnpm, never try the network
# for it, and reuse the cached Git runtime. Only an older image needs ~/.local/bin on PATH.
# shellcheck disable=SC2016 # these lines expand in the Outpost's shell, not here.
{
  echo '# outpost-deps: pnpm through corepack, with packages cached by the deps helper'
  docker exec "$container" test -e /usr/local/bin/pnpm || echo 'export PATH="$HOME/.local/bin:$PATH"'
  echo 'export COREPACK_ENABLE_NETWORK=0'
  echo 'export PWRGIT_RUNTIME_CACHE="$HOME/.cache/pwrgit-runtime-cache"'
} | docker exec -i "$container" sh -c 'f="$HOME/.profile"; grep -qs "PWRGIT_RUNTIME_CACHE" "$f" || cat >> "$f"'
echo "Dependencies cached from $(git -C "$repo" rev-parse --short "$ref^{commit}"); run pnpm install in each checkout"
