#!/usr/bin/env node
// Reuse a built apps/desktop/out across the macOS Desktop E2E lanes of one
// commit.
//
// Every lane used to run `pretest:e2e`, which rebuilds out/ from scratch
// (~32 s on a 4 vCPU guest). The lanes run on persistent PwrSuiteLab guests,
// one job at a time, and a guest usually serves two lanes of the same commit,
// so the second build repeats the first byte for byte. This keeps each
// finished build in a guest-local directory and copies it back when the same
// source tree comes round again.
//
//   prepare  Restore out/ for the current tree, or build it and save it.
//            Writes a stamp naming the tree the out/ belongs to.
//   verify   Fail unless the stamp names the current tree. `test:e2e:prebuilt`
//            runs this before Playwright, so a skipped or failed prepare can
//            never send a lane into the suite with some other tree's bundle.
//
// The key is the Git tree SHA of HEAD: a hash of every tracked file, so two
// checkouts share an entry only when their sources are identical. That
// includes pnpm-lock.yaml and the packageManager pin, which fix the
// dependency graph the bundle is built from. A small build-environment guard
// adds what the tree cannot see: the Node version and platform, and a refusal
// to use the cache at all when an environment variable that changes
// electron-vite's output is set (the dev-only React DevTools and profiling
// switches, Vite's own VITE_* variables, NODE_ENV). A checkout whose tracked
// files differ from HEAD is built fresh and never saved.
//
// Local runs are unaffected: `pnpm test:desktop-e2e` still builds first.
// `prepare` refuses to run without PWRAGENT_CI_CACHE_ROOT, which only the CI
// job sets.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Bump when the entry layout or the key recipe changes.
const CACHE_FORMAT = 1;
// Each entry is one out/ directory, cloned on APFS, so a handful costs
// little disk. Two lanes per commit per guest only ever need the newest.
export const MAX_ENTRIES = 6;
const STALE_TEMP_MS = 60 * 60 * 1000;

const BUILD_ENV_PATTERN = /^(PWRAGENT_DEV_REACT_|VITE_)/;

/** Why this environment must not use the cache, or null when it may. */
export function buildEnvBypassReason(env = process.env) {
  const names = Object.keys(env)
    .filter((name) => (
      (BUILD_ENV_PATTERN.test(name) || name === "NODE_ENV")
      && env[name] !== undefined
      && env[name] !== ""
    ))
    .sort();
  return names.length > 0
    ? `build-affecting environment set: ${names.join(", ")}`
    : null;
}

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

export function readTree(repoRoot) {
  return git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
}

/** True when a tracked file differs from HEAD, so the tree SHA lies. */
export function hasTrackedChanges(repoRoot) {
  return git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]) !== "";
}

export function computeCacheKey({
  tree,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
}) {
  const guard = createHash("sha256")
    .update(JSON.stringify({ format: CACHE_FORMAT, nodeVersion, platform, arch }))
    .digest("hex")
    .slice(0, 12);
  return `${tree}-${guard}`;
}

const entriesDir = (cacheRoot) => path.join(cacheRoot, "desktop-out");
const entryDir = (cacheRoot, key) => path.join(entriesDir(cacheRoot), key);

function cloneTree(source, destination) {
  // FICLONE makes an APFS copy-on-write clone and falls back to a byte copy
  // on a filesystem without clones.
  cpSync(source, destination, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

function readManifest(entry) {
  try {
    return JSON.parse(readFileSync(path.join(entry, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Copy a saved out/ into place. Only a complete entry is served: an entry is
 * renamed into place after its manifest is written, so a directory under the
 * key always holds a whole build. The cache is an optimization, so any
 * problem with an entry is a miss, never a failed lane. A bad entry is
 * removed, or it would block saveEntry from replacing it.
 */
export function restoreEntry({ cacheRoot, key, outDir, log = console.log }) {
  const entry = entryDir(cacheRoot, key);
  if (!existsSync(entry)) {
    return false;
  }
  const manifest = readManifest(entry);
  try {
    if (manifest?.key !== key || !existsSync(path.join(entry, "out"))) {
      throw new Error("incomplete entry");
    }
    rmSync(outDir, { recursive: true, force: true });
    cloneTree(path.join(entry, "out"), outDir);
    // Mark the entry recently used, so eviction keeps it.
    const now = new Date();
    utimesSync(entry, now, now);
    return true;
  } catch (error) {
    log(`desktop out/ cache entry ${key} is unusable (${error.message}); discarding it.`);
    rmSync(entry, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    return false;
  }
}

export function saveEntry({ cacheRoot, key, outDir, tree }) {
  const parent = entriesDir(cacheRoot);
  mkdirSync(parent, { recursive: true });
  const entry = entryDir(cacheRoot, key);
  if (existsSync(entry)) {
    return false;
  }
  const temp = path.join(parent, `.tmp-${key}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp);
  cloneTree(outDir, path.join(temp, "out"));
  writeFileSync(
    path.join(temp, "manifest.json"),
    `${JSON.stringify({ key, tree, savedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  try {
    renameSync(temp, entry);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (existsSync(entry)) {
      return false;
    }
    throw error;
  }
  return true;
}

/** Keep the newest `keep` entries and drop abandoned temp directories. */
export function evictEntries({ cacheRoot, keep = MAX_ENTRIES, now = Date.now() }) {
  const parent = entriesDir(cacheRoot);
  if (!existsSync(parent)) {
    return [];
  }
  const removed = [];
  const entries = [];
  for (const name of readdirSync(parent)) {
    const full = path.join(parent, name);
    const mtimeMs = statSync(full).mtimeMs;
    if (name.startsWith(".tmp-")) {
      if (now - mtimeMs > STALE_TEMP_MS) {
        rmSync(full, { recursive: true, force: true });
        removed.push(name);
      }
      continue;
    }
    entries.push({ name, full, mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of entries.slice(keep)) {
    rmSync(stale.full, { recursive: true, force: true });
    removed.push(stale.name);
  }
  return removed;
}

const stampPath = (repoRoot) =>
  path.join(repoRoot, "apps", "desktop", ".local", "ci-desktop-out.json");

function writeStamp(repoRoot, stamp) {
  const file = stampPath(repoRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
}

function runBuild(repoRoot) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@pwragent/desktop", "build"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`desktop build failed with exit status ${result.status}`);
  }
}

export function prepare({
  repoRoot,
  cacheRoot,
  env = process.env,
  build = () => runBuild(repoRoot),
  log = console.log,
}) {
  const outDir = path.join(repoRoot, "apps", "desktop", "out");
  const tree = readTree(repoRoot);
  const bypass = buildEnvBypassReason(env)
    ?? (hasTrackedChanges(repoRoot) ? "tracked files differ from HEAD" : null);
  if (bypass) {
    log(`desktop out/ cache bypassed (${bypass}); building fresh.`);
    build();
    writeStamp(repoRoot, { tree, source: "build-uncached", reason: bypass });
    return "build-uncached";
  }

  const key = computeCacheKey({ tree });
  if (restoreEntry({ cacheRoot, key, outDir, log })) {
    log(`desktop out/ cache hit: ${key}`);
    writeStamp(repoRoot, { tree, key, source: "cache" });
    return "cache";
  }

  log(`desktop out/ cache miss: ${key}; building.`);
  build();
  // The build succeeded, so a failed save (a full disk, say) must not fail
  // the lane: it only costs the next lane a rebuild.
  try {
    const saved = saveEntry({ cacheRoot, key, outDir, tree });
    const removed = evictEntries({ cacheRoot });
    log(
      `desktop out/ ${saved ? "saved" : "already saved"} as ${key}`
        + (removed.length > 0 ? `; evicted ${removed.join(", ")}` : ""),
    );
  } catch (error) {
    log(`desktop out/ could not be saved as ${key}: ${error.message}`);
  }
  writeStamp(repoRoot, { tree, key, source: "build" });
  return "build";
}

export function verify({ repoRoot }) {
  const file = stampPath(repoRoot);
  const outEntry = path.join(repoRoot, "apps", "desktop", "out", "main", "index.js");
  if (!existsSync(file) || !existsSync(outEntry)) {
    return "no prebuilt apps/desktop/out for this checkout";
  }
  const stamp = JSON.parse(readFileSync(file, "utf8"));
  const tree = readTree(repoRoot);
  if (stamp.tree !== tree) {
    return `apps/desktop/out was built for tree ${stamp.tree}, but HEAD is tree ${tree}`;
  }
  return null;
}

function main(argv) {
  const command = argv[0];
  const repoRoot = execFileSync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  if (command === "prepare") {
    const cacheRoot = process.env.PWRAGENT_CI_CACHE_ROOT;
    if (!cacheRoot) {
      throw new Error(
        "PWRAGENT_CI_CACHE_ROOT is not set. This script is for the macOS "
          + "Desktop E2E CI lane; run `pnpm test:desktop-e2e` locally.",
      );
    }
    prepare({ repoRoot, cacheRoot });
    return 0;
  }
  if (command === "verify") {
    const problem = verify({ repoRoot });
    if (problem) {
      console.error(
        `${problem}. test:e2e:prebuilt runs only after `
          + "`scripts/ci/desktop-out-cache.mjs prepare`; use test:e2e, which builds.",
      );
      return 1;
    }
    return 0;
  }
  console.error("usage: desktop-out-cache.mjs prepare|verify");
  return 2;
}

// import.meta.url is the module's real path, while argv[1] keeps any symlink
// in the path it was invoked by (/tmp on macOS), so compare real paths.
// Otherwise `prepare` would exit 0 having done nothing.
if (
  process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2));
}
