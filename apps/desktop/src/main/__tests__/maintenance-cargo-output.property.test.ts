import { execFile, spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scanCargoBuildOutputs, removeCargoBuildOutput } from "../app-server/maintenance-cargo-output";
import { acquireMaintenanceLock } from "../app-server/maintenance-native-lock";

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const cargoExecutable = process.env.CARGO ?? "cargo";
let root: string, helperPath: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "maintenance-cargo-")));
  const builder = pathToFileURL(fileURLToPath(new URL("../../../scripts/build-mcp-ipc-relay.mjs", import.meta.url))).href;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e",
    `import {buildMcpIpcRelay} from ${JSON.stringify(builder)}; process.stdout.write(buildMcpIpcRelay({outputRoot:process.argv[1]}));`, root]);
  helperPath = stdout.trim().split(/\r?\n/).at(-1)!;
}, 30_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function fixture(targetName = "target", profileName = "debug") {
  const repo = await mkdtemp(path.join(root, "repo-"));
  const git = async (...args: string[]) => await exec("git", ["-C", repo, ...args]);
  await git("init", "-b", "main");
  await writeFile(path.join(repo, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
  await writeFile(path.join(repo, "source.rs"), "source that must stay\n");
  await git("add", ".");
  const target = path.join(repo, targetName);
  const profile = path.join(target, profileName);
  await mkdir(path.join(profile, "deps"), { recursive: true });
  await writeFile(path.join(target, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  await writeFile(path.join(profile, ".cargo-lock"), "");
  await writeFile(path.join(profile, "deps", "fixture.rmeta"), Buffer.alloc(8192));
  await writeFile(path.join(profile, ".env.local"), "operator data\n");
  return { repo, profile, target, git };
}

describe("Cargo output cleanup", () => {
  // Model: output profile names and target location do not depend on the
  // thread's age or on unrelated ignored/operator files in the checkout.
  it("finds Cargo profiles in standard, custom and nested target directories", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("target", "target-app", path.join("local-state", "stdio-bridge-target")),
      fc.constantFrom("debug", "release", path.join("aarch64-apple-darwin", "release")), async (targetName, profileName) => {
      const { repo, profile } = await fixture(targetName, profileName);
      const discovery = await scanCargoBuildOutputs([repo, repo], signal(), undefined, { helperPath });
      expect(discovery.kept).toEqual([]);
      expect(discovery.items.map((item) => item.row.outputPath)).toEqual([profile]);
    }), { numRuns: 6 });
  });

  // Filesystem/Git oracle: source, unrelated files, and the existing lock
  // inode survive; only Cargo products disappear. A second run is harmless.
  it("preserves source, user data and lock identity when compiled files are removed", async () => {
    const { repo, profile, git } = await fixture();
    const before = (await git("diff", "--cached", "--binary")).stdout;
    const lock = path.join(profile, ".cargo-lock");
    const inode = (await lstat(lock)).ino;
    const { items } = await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath });
    expect(items).toHaveLength(1);
    const result = await removeCargoBuildOutput(items[0]!, signal(), { helperPath });
    expect(result.kept).toBeUndefined();
    expect((await lstat(lock)).ino).toBe(inode);
    expect(await readFile(path.join(profile, ".env.local"), "utf8")).toBe("operator data\n");
    expect((await git("diff", "--cached", "--binary")).stdout).toBe(before);
    await expect(lstat(path.join(profile, "deps"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath })).items).toEqual([]);
  });

  it("refuses a lock held by another process at scan and again at apply", async () => {
    const { repo, profile } = await fixture();
    const { items } = await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath });
    const lease = await acquireMaintenanceLock(path.join(profile, ".cargo-lock"), helperPath);
    expect(lease).toBeDefined();
    try {
      expect((await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath })).items).toEqual([]);
      expect(await removeCargoBuildOutput(items[0]!, signal(), { helperPath })).toEqual({ kept: "Cargo build in progress" });
      expect(await lstat(path.join(profile, "deps"))).toBeDefined();
    } finally { await lease?.release(); }
  });

  it("keeps tracked files and skips profiles that vanished after review", async () => {
    const { repo, profile, git } = await fixture();
    const { items } = await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath });
    await git("add", path.relative(repo, path.join(profile, "deps")));
    expect((await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath })).items).toEqual([]);
    await expect(removeCargoBuildOutput(items[0]!, signal(), { helperPath })).rejects.toThrow("tracked files");
    await rm(profile, { recursive: true });
    expect(await removeCargoBuildOutput(items[0]!, signal(), { helperPath })).toEqual({ alreadyGone: true });
  });

  it.skipIf(process.platform === "win32")("never follows a profile replaced by a symlink", async () => {
    const { repo, profile } = await fixture();
    const { items } = await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath });
    const outside = await mkdtemp(path.join(root, "outside-"));
    await writeFile(path.join(outside, "keep"), "source");
    await rm(profile, { recursive: true });
    await symlink(outside, profile);
    await expect(removeCargoBuildOutput(items[0]!, signal(), { helperPath })).rejects.toThrow("changed");
    expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("source");
  });

  it.skipIf(process.platform === "win32")("an unreadable source folder does not hide other build output", async () => {
    const { repo, profile } = await fixture();
    const blocked = path.join(repo, "blocked");
    await mkdir(blocked);
    await chmod(blocked, 0);
    try {
      const result = await scanCargoBuildOutputs([repo], signal(), undefined, { helperPath });
      expect(result.items.map((item) => item.row.outputPath)).toEqual([profile]);
      expect(result.kept).toContainEqual({ path: blocked, reason: "Cargo folder could not be read" });
    } finally { await chmod(blocked, 0o700); }
  });

  // Cargo itself is the independent lock oracle, including shared-lock
  // compatibility in newer Cargo versions. No dependencies or network.
  it.skipIf(spawnSync(cargoExecutable, ["--version"], { windowsHide: true }).status !== 0)("honors a real Cargo build's lock", async () => {
    const { repo, profile, target } = await fixture();
    await mkdir(path.join(repo, "src"));
    await writeFile(path.join(repo, "src", "main.rs"), "fn main() {}\n");
    const entered = path.join(repo, "entered"), release = path.join(repo, "release");
    await writeFile(path.join(repo, "build.rs"), `fn main(){std::fs::write(${JSON.stringify(entered)},b"ready").unwrap();while !std::path::Path::new(${JSON.stringify(release)}).exists(){std::thread::sleep(std::time::Duration::from_millis(10));}}`);
    const cargo = spawn(cargoExecutable, ["build", "--offline", "--manifest-path", path.join(repo, "Cargo.toml"), "--target-dir", target], { stdio: "ignore", windowsHide: true });
    const closed = new Promise<number | null>((resolve) => cargo.once("close", resolve));
    try {
      await vi.waitFor(async () => expect(await readFile(entered, "utf8")).toBe("ready"), { timeout: 15_000 });
      expect(await acquireMaintenanceLock(path.join(profile, ".cargo-lock"), helperPath)).toBeUndefined();
    } finally { await writeFile(release, "go"); expect(await closed).toBe(0); }
  }, 25_000);
});
