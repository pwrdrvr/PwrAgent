#!/bin/sh
# Push a local Git repository into a contained Outpost and register it as a project.
# The Outpost never contacts a forge: only Git objects and refs cross in, through docker exec.
#
# Usage: push-repo.sh <local-repo> [project-name] [branch]
#   OUTPOST_CONTAINER   default pwragent-outpost
#
# First push:
#   - a normal repository arrives as a git bundle; every pushed branch becomes a local branch.
#   - a shallow repository cannot be bundled usefully, so a depth-500 clone is copied in.
#   With a branch, only that branch crosses and is checked out.
# Later pushes fetch new commits into refs/remotes/host/* and never touch the agent's branches.
# Git LFS hooks are removed: the container has no git-lfs, and they make worktree creation fail.
set -eu
repo="$(cd "$1" && git rev-parse --show-toplevel)"
name="${2:-$(basename "$repo")}"
branch="${3:-}"
case "$name" in *[!A-Za-z0-9._-]*|.*) echo "bad project name: $name" >&2; exit 2;; esac
container="${OUTPOST_CONTAINER:-pwragent-outpost}"
dest="/home/outpost/workspace/$name"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bundle="$work/$name.bundle"
cli=/opt/outpost-tools/node_modules/.bin/pwragent

send_bundle() {
  git bundle verify "$bundle" >/dev/null
  docker cp "$bundle" "$container:/tmp/$name.bundle"
}
full_bundle() {
  if [ -n "$branch" ]; then git -C "$repo" bundle create "$bundle" "$branch"; else git -C "$repo" bundle create "$bundle" --branches --tags; fi
  send_bundle
}

if docker exec "$container" test -d "$dest/.git"; then
  if [ -n "$branch" ]; then
    # Send only what the Outpost lacks; a full bundle from a shallow source cannot be read.
    base="$(docker exec "$container" git -C "$dest" rev-parse --verify -q "refs/remotes/host/$branch" \
      || docker exec "$container" git -C "$dest" rev-parse --verify -q "refs/heads/$branch")"
    git -C "$repo" bundle create "$bundle" "$base..$branch"
    send_bundle
  else
    full_bundle
  fi
  docker exec "$container" git -C "$dest" fetch --no-tags "/tmp/$name.bundle" "+refs/heads/*:refs/remotes/host/*"
  echo "Fetched into refs/remotes/host/* in $dest"
elif [ "$(git -C "$repo" rev-parse --is-shallow-repository)" = true ]; then
  stage="$work/$name"
  git clone --quiet --no-local --depth 500 ${branch:+--branch "$branch"} "file://$repo" "$stage"
  git -C "$stage" remote remove origin
  docker exec "$container" mkdir -p "$dest"
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -cf - . | docker exec -i "$container" tar -C "$dest" -xf -
  echo "Copied a depth-500 clone into $dest"
else
  full_bundle
  docker exec "$container" git clone --quiet --origin host ${branch:+--branch "$branch"} "/tmp/$name.bundle" "$dest"
  docker exec "$container" sh -c 'cd "$1" && git for-each-ref --format="%(refname:strip=3)" refs/remotes/host \
    | while read -r b; do [ "$b" = HEAD ] || git show-ref -q --verify "refs/heads/$b" || git branch -q "$b" "refs/remotes/host/$b"; done' _ "$dest"
  docker exec "$container" git -C "$dest" remote remove host
  echo "Cloned into $dest"
fi
docker exec "$container" rm -f "/tmp/$name.bundle"
docker exec "$container" sh -c 'for h in "$1"/.git/hooks/*; do grep -qs "git-lfs\|git lfs" "$h" && rm -f "$h"; done; true' _ "$dest"

printf '{"path":"%s"}\n' "$dest" | docker exec -i "$container" sh -c 'cat > /tmp/register-directory.json'
docker exec "$container" "$cli" register-directory --params-file /tmp/register-directory.json >/dev/null
docker exec "$container" rm -f /tmp/register-directory.json
echo "Project key: directory:$dest"
