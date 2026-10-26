import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEnvBypassReason,
  computeCacheKey,
  evictEntries,
  prepare,
  readTree,
  saveEntry,
  verify,
} from "./desktop-out-cache.mjs";

// The cache may only ever hand a lane the bundle of its own source tree. These
// tests drive the real script against a throwaway Git repository with an
// injected build, so they cover the key, the guard, and the restore path
// without running electron-vite.
let scratch;
let repoRoot;
let cacheRoot;
let builds;

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const outFile = (relative) =>
  path.join(repoRoot, "apps", "desktop", "out", relative);

/** Stand-in for electron-vite: writes out/ derived from the source file. */
function fakeBuild() {
  builds += 1;
  const source = readFileSync(path.join(repoRoot, "src.txt"), "utf8");
  rmSync(path.join(repoRoot, "apps", "desktop", "out"), { recursive: true, force: true });
  mkdirSync(path.dirname(outFile("main/index.js")), { recursive: true });
  writeFileSync(outFile("main/index.js"), `built from ${source}`);
}

function commit(content) {
  writeFileSync(path.join(repoRoot, "src.txt"), content);
  git("add", "src.txt");
  git("commit", "-q", "-m", content);
}

const run = (env = {}) =>
  prepare({ repoRoot, cacheRoot, env, build: fakeBuild, log: () => {} });

const stamp = () => JSON.parse(readFileSync(
  path.join(repoRoot, "apps", "desktop", ".local", "ci-desktop-out.json"),
  "utf8",
));

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "desktop-out-cache-"));
  repoRoot = path.join(scratch, "repo");
  cacheRoot = path.join(scratch, "cache");
  builds = 0;
  mkdirSync(repoRoot);
  git("init", "-q");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "CI");
  git("config", "commit.gpgsign", "false");
  // Mirror the repository: out/ and .local/ are ignored build products.
  writeFileSync(path.join(repoRoot, ".gitignore"), "out/\n.local/\n");
  git("add", ".gitignore");
  commit("v1");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("desktop out/ cache", () => {
  it("builds on a miss, then serves the same tree from the cache", () => {
    expect(run()).toBe("build");
    expect(builds).toBe(1);

    // A later lane starts from a clean checkout of the same commit.
    rmSync(path.join(repoRoot, "apps", "desktop", "out"), { recursive: true });
    expect(run()).toBe("cache");
    expect(builds).toBe(1);
    expect(readFileSync(outFile("main/index.js"), "utf8")).toBe("built from v1");
    expect(stamp()).toMatchObject({ source: "cache", tree: readTree(repoRoot) });
  });

  it("never serves one tree's build to another", () => {
    run();
    commit("v2");
    expect(run()).toBe("build");
    expect(builds).toBe(2);
    expect(readFileSync(outFile("main/index.js"), "utf8")).toBe("built from v2");
  });

  it("keys on content, so an identical tree on another commit hits", () => {
    run();
    git("commit", "-q", "--allow-empty", "-m", "same tree");
    expect(run()).toBe("cache");
  });

  it("builds fresh and saves nothing when tracked files differ from HEAD", () => {
    writeFileSync(path.join(repoRoot, "src.txt"), "uncommitted");
    expect(run()).toBe("build-uncached");
    expect(readFileSync(outFile("main/index.js"), "utf8")).toBe("built from uncommitted");
    expect(existsSync(path.join(cacheRoot, "desktop-out"))).toBe(false);
  });

  it.each([
    ["PWRAGENT_DEV_REACT_PROFILING", "1"],
    ["PWRAGENT_DEV_REACT_DEVTOOLS", "1"],
    ["PWRAGENT_DEV_REACT_DEVTOOLS_PORT", "8098"],
    ["VITE_SOMETHING", "x"],
    ["NODE_ENV", "development"],
  ])("refuses the cache when %s is set", (name, value) => {
    run();
    expect(run({ [name]: value })).toBe("build-uncached");
    expect(stamp().reason).toContain(name);
  });

  it("ignores unrelated and empty variables", () => {
    expect(buildEnvBypassReason({ PATH: "/bin", PWRAGENT_E2E_DISABLE_GPU: "1" })).toBeNull();
    expect(buildEnvBypassReason({ PWRAGENT_DEV_REACT_PROFILING: "" })).toBeNull();
  });

  it("separates entries by Node version and platform", () => {
    const tree = readTree(repoRoot);
    const base = computeCacheKey({ tree, nodeVersion: "v24.22.1", platform: "darwin", arch: "arm64" });
    expect(base.startsWith(`${tree}-`)).toBe(true);
    expect(computeCacheKey({ tree, nodeVersion: "v24.23.0", platform: "darwin", arch: "arm64" })).not.toBe(base);
    expect(computeCacheKey({ tree, nodeVersion: "v24.22.1", platform: "darwin", arch: "x64" })).not.toBe(base);
  });

  const onlyEntry = () => {
    const entries = readdirSync(path.join(cacheRoot, "desktop-out"));
    expect(entries).toHaveLength(1);
    return path.join(cacheRoot, "desktop-out", entries[0]);
  };

  it.each([
    ["has no manifest", (entry) => rmSync(path.join(entry, "manifest.json"))],
    ["has an unreadable manifest", (entry) => writeFileSync(path.join(entry, "manifest.json"), "{")],
    ["has no out/", (entry) => rmSync(path.join(entry, "out"), { recursive: true })],
  ])("rebuilds and replaces an entry that %s", (_label, damage) => {
    run();
    damage(onlyEntry());
    expect(run()).toBe("build");
    expect(builds).toBe(2);
    // The replacement is complete, so the next lane hits again.
    expect(run()).toBe("cache");
    expect(readFileSync(outFile("main/index.js"), "utf8")).toBe("built from v1");
  });

  it("keeps a successful build when the cache cannot be written", () => {
    // A file where the entries directory belongs makes every save fail.
    mkdirSync(cacheRoot);
    writeFileSync(path.join(cacheRoot, "desktop-out"), "");
    expect(run()).toBe("build");
    expect(readFileSync(outFile("main/index.js"), "utf8")).toBe("built from v1");
    expect(verify({ repoRoot })).toBeNull();
  });

  it("keeps only the newest entries and drops abandoned temp directories", () => {
    const outDir = path.join(repoRoot, "apps", "desktop", "out");
    fakeBuild();
    for (let index = 0; index < 4; index += 1) {
      saveEntry({ cacheRoot, key: `key-${index}`, outDir, tree: "t" });
      const at = new Date(Date.UTC(2026, 0, 1 + index));
      utimesSync(path.join(cacheRoot, "desktop-out", `key-${index}`), at, at);
    }
    const temp = path.join(cacheRoot, "desktop-out", ".tmp-abandoned-1");
    mkdirSync(temp);
    utimesSync(temp, new Date(0), new Date(0));

    const removed = evictEntries({ cacheRoot, keep: 2 });
    expect(removed.sort()).toEqual([".tmp-abandoned-1", "key-0", "key-1"]);
    expect(existsSync(path.join(cacheRoot, "desktop-out", "key-3"))).toBe(true);
  });

  it("verify accepts only the tree the stamp names", () => {
    expect(verify({ repoRoot })).toMatch(/no prebuilt/);
    run();
    expect(verify({ repoRoot })).toBeNull();
    commit("v2");
    expect(verify({ repoRoot })).toMatch(/built for tree/);
  });
});
