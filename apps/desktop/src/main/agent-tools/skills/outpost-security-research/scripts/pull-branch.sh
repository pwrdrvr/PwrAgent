#!/bin/sh
# Bring a branch an agent made on a contained Outpost back into a local repository.
#
# Usage: pull-branch.sh <project-name> <branch> <local-repo>
#   OUTPOST_CONTAINER   default pwragent-outpost
#
# The branch lands as refs/remotes/outpost/<branch>; nothing local is overwritten.
# Review it before you merge it: an untrusted model wrote it.
set -eu
name="$1"; branch="$2"; repo="$(cd "$3" && git rev-parse --show-toplevel)"
case "$name" in *[!A-Za-z0-9._-]*|.*) echo "bad project name: $name" >&2; exit 2;; esac
container="${OUTPOST_CONTAINER:-pwragent-outpost}"
dest="/home/outpost/workspace/$name"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
docker exec "$container" git -C "$dest" bundle create "/tmp/$name-out.bundle" "$branch"
docker cp "$container:/tmp/$name-out.bundle" "$work/out.bundle"
docker exec "$container" rm -f "/tmp/$name-out.bundle"
git bundle verify "$work/out.bundle" >/dev/null
git -C "$repo" fetch "$work/out.bundle" "+refs/heads/$branch:refs/remotes/outpost/$branch"
echo "Fetched outpost/$branch into $repo"
