#!/usr/bin/env bash
# Keep the macOS Desktop E2E lane's pnpm store on the guest between jobs.
#
# The lane runs on persistent PwrSuiteLab guests: each job gets a new runner
# listener, but the VM and its disk stay up. configure-nodejs keeps the pnpm
# store inside the workspace, so checkout's `git clean -ffdx` deleted it at the
# start of every job, and every job then restored the same 750 MB dependency
# cache archive (~50 s on these guests) only for `pnpm install` to finish in
# ~4 s. This script moves the store, and the Electron download caches,
# outside the workspace where the clean cannot reach them.
#
#   check    Decide whether the guest store is warm. Exports
#            PWRAGENT_CI_CACHE_ROOT and writes `warm=true|false` to
#            GITHUB_OUTPUT. A store older than MAX_AGE_DAYS is deleted here, so
#            it is re-seeded from the current lockfile's cache. That bounds the
#            store's growth: packages that no later lockfile uses go with it.
#   seed     Cold path, after configure-nodejs has restored and installed as it
#            always did: move its store and Electron caches onto the guest.
#   install  Warm path: activate pnpm through Corepack and run
#            `pnpm install --frozen-lockfile` against the guest store. Packages
#            the store lacks still come from the registry.
#
# Scope, because the guest is shared with PwrSnap and with operator work:
# everything lives under PWRAGENT_CI_CACHE_ROOT, a directory only this
# repository's CI uses. A runner executes one job at a time, and pnpm's store
# is safe for concurrent use besides.
#
# Test seams (see macos-e2e-guest-store.test.mjs): PWRAGENT_CI_CACHE_ROOT
# overrides the location, and PWRAGENT_CI_NOW overrides the clock (epoch
# seconds).
set -euo pipefail

MAX_AGE_DAYS=14

root="${PWRAGENT_CI_CACHE_ROOT:-${HOME:?}/Library/Caches/pwragent-ci}"
# Every delete below is under this root, so refuse anything that is not a
# real absolute directory path.
if [[ "$root" != /* || "$root" == "/" ]]; then
  echo "::error::Refusing guest cache root '$root'" >&2
  exit 1
fi
store="$root/pnpm-store"
marker="$store/.pwragent-seeded"
now="${PWRAGENT_CI_NOW:-$(date +%s)}"

export_store_env() {
  {
    echo "PNPM_CONFIG_STORE_DIR=$store"
    echo "npm_config_store_dir=$store"
    echo "electron_config_cache=$root/electron"
    echo "npm_config_cache=$root/npm"
  } >> "${GITHUB_ENV:?}"
  export PNPM_CONFIG_STORE_DIR="$store"
  export npm_config_store_dir="$store"
  export electron_config_cache="$root/electron"
  export npm_config_cache="$root/npm"
}

drop_store() {
  rm -rf "$store" "$root/electron" "$root/npm"
}

check() {
  echo "PWRAGENT_CI_CACHE_ROOT=$root" >> "${GITHUB_ENV:?}"
  local warm=false
  if [[ -f "$marker" ]]; then
    local seeded age
    seeded="$(cat "$marker")"
    if [[ "$seeded" =~ ^[0-9]+$ ]]; then
      age=$(( now - seeded ))
      if (( age >= 0 && age < MAX_AGE_DAYS * 86400 )); then
        warm=true
        echo "Guest pnpm store is warm (seeded $(( age / 3600 )) h ago): $store"
      else
        echo "Guest pnpm store expired (seeded $(( age / 86400 )) d ago); re-seeding."
        drop_store
      fi
    else
      echo "Guest pnpm store marker is unreadable; re-seeding."
      drop_store
    fi
  elif [[ -e "$store" ]]; then
    # A store without a marker was never completely seeded.
    echo "Guest pnpm store has no seed marker; re-seeding."
    drop_store
  else
    echo "No guest pnpm store yet; seeding from the dependency cache."
  fi
  echo "warm=$warm" >> "${GITHUB_OUTPUT:?}"
}

# Move a directory into place whole, so an interrupted move never leaves a
# half-filled destination under the final name.
move_into() {
  local source="$1" destination="$2"
  if [[ ! -d "$source" ]]; then
    return 0
  fi
  rm -rf "$destination.incoming"
  mv "$source" "$destination.incoming"
  rm -rf "$destination"
  mv "$destination.incoming" "$destination"
}

seed() {
  local workspace="${GITHUB_WORKSPACE:?}"
  if [[ ! -d "$workspace/.pnpm-store" ]]; then
    echo "::warning::configure-nodejs left no workspace pnpm store; the guest store stays cold."
    return 0
  fi
  mkdir -p "$root"
  drop_store
  move_into "$workspace/.pnpm-store" "$store"
  move_into "$workspace/.cache/configure-nodejs/electron" "$root/electron"
  move_into "$workspace/.cache/configure-nodejs/npm" "$root/npm"
  # The marker is written last: it is what makes the next job trust the store.
  echo "$now" > "$marker"
  export_store_env
  echo "Seeded the guest pnpm store at $store"
}

install() {
  export_store_env
  export COREPACK_HOME="$root/corepack"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  {
    echo "COREPACK_HOME=$COREPACK_HOME"
    echo "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
  } >> "${GITHUB_ENV:?}"

  corepack enable pnpm
  # Installs the packageManager pin from package.json and checks its hash.
  corepack install
  local expected actual
  expected="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "").split("+")[0]')"
  actual="$(pnpm --version)"
  if [[ "$actual" != "$expected" ]]; then
    echo "::error::Expected pnpm $expected, got $actual" >&2
    exit 1
  fi
  echo "Activated pnpm $actual; store $(pnpm store path)"
  pnpm install --frozen-lockfile
}

case "${1:-}" in
  check) check ;;
  seed) seed ;;
  install) install ;;
  *)
    echo "usage: $0 check|seed|install" >&2
    exit 2
    ;;
esac
