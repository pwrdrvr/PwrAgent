import { lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { REBUILDABLE_OUTPUT_NAMES, type ThreadMaintenanceBuildOutput } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import { acquireMaintenanceLock, type MaintenanceLock } from "./maintenance-native-lock";
import { measureMaintenanceAllocationPaths } from "./maintenance-disk-usage";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";

const CARGO_LOCKS = new Set([".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"]);
const ARTIFACT_FOLDERS = new Set(["deps", ".fingerprint", "incremental", "build", "examples"]);
const SOURCE_SKIP = new Set([...REBUILDABLE_OUTPUT_NAMES, ".git", ".local", ".codex", ".claude", ".pwragent"]);
const MAX_SOURCE_FOLDERS = 5000;
const CACHE_SIGNATURE = "Signature: 8a477f597d28d172789f06886806bc55";

export type CargoBuildOutputCandidate = { row: ThreadMaintenanceBuildOutput; identity: string };
export type CargoBuildOutputDiscovery = { items: CargoBuildOutputCandidate[]; kept: { path: string; reason: string }[] };

async function regular(target: string): Promise<boolean> {
  try { return (await lstat(target)).isFile(); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function repositoryBoundary(folder: string): Promise<boolean> {
  try { await lstat(path.join(folder, ".git")); return true; }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function cargoTarget(folder: string): Promise<boolean> {
  const tag = path.join(folder, "CACHEDIR.TAG");
  if (await regular(tag) && (await lstat(tag)).size <= 4096 && (await readFile(tag, "utf8")).startsWith(CACHE_SIGNATURE)) return true;
  for (const name of [".rustc_info.json", ".rustc-info.json"]) {
    const file = path.join(folder, name);
    if (!await regular(file) || (await lstat(file)).size > 1024 * 1024) continue;
    try { if (typeof JSON.parse(await readFile(file, "utf8")).rustc_fingerprint === "number") return true; } catch { /* not Cargo metadata */ }
  }
  return false;
}

/** No symlinks at the checkout, target or profile boundary. A replace or
 * rename after review changes the token and keeps the output. */
async function identity(row: ThreadMaintenanceBuildOutput): Promise<string> {
  const relative = path.relative(row.checkoutPath, row.outputPath);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Output is outside its checkout");
  const parts = relative.split(path.sep);
  const tokens: string[] = [];
  let current = row.checkoutPath;
  for (const segment of ["", ...parts]) {
    if (segment) current = path.join(current, segment);
    if (segment && await repositoryBoundary(current)) throw new Error("Output repository changed");
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Output directory changed");
    tokens.push(`${info.dev}:${info.ino}`);
  }
  const lock = await lstat(path.join(row.outputPath, ".cargo-lock"));
  if (!lock.isFile() || lock.isSymbolicLink()) throw new Error("Cargo lock changed");
  return [...tokens, `${lock.dev}:${lock.ino}`].join("|");
}

/** Only Cargo artifact directories and binaries/dependency products are
 * removed. User files beside them (including .env files) stay untouched. */
async function artifactPaths(profile: string, signal: AbortSignal): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(profile, { withFileTypes: true })) {
    if (CARGO_LOCKS.has(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(profile, entry.name);
    if (entry.isDirectory()) {
      if (ARTIFACT_FOLDERS.has(entry.name) || entry.name.endsWith(".dSYM")) {
        await assertNoNestedRepository(file, signal);
        result.push(file);
      }
    } else if (entry.isFile()) {
      if (/\.(?:d|rlib|rmeta|a|so|dylib|dll|exe|pdb|lib|exp)$/.test(entry.name)) { result.push(file); continue; }
      const handle = await open(file, "r");
      try {
        const bytes = Buffer.alloc(4);
        const read = await handle.read(bytes, 0, 4, 0);
        if (read.bytesRead === 4 && ([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(bytes.readUInt32BE(0))
          || bytes.subarray(0, 2).toString() === "MZ" || bytes.toString() === "!<ar")) result.push(file);
      } finally { await handle.close(); }
    }
  }
  return result;
}

/** Recursive removal must not erase an embedded repository's index or files. */
async function assertNoNestedRepository(folder: string, signal: AbortSignal): Promise<void> {
  const queue = [folder];
  for (let index = 0; index < queue.length; index++) {
    signal.throwIfAborted();
    const current = queue[index]!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === ".git") throw new Error("Nested Git repository in build output");
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path.join(current, entry.name));
    }
  }
}

async function assertUntracked(row: ThreadMaintenanceBuildOutput, signal: AbortSignal): Promise<void> {
  const canonical = async (folder: string) => {
    const target = await realpath(folder);
    return process.platform === "win32" ? target.toLowerCase() : target;
  };
  const expected = await canonical(row.checkoutPath);
  // Ask Git at the actual output and manifest locations. A parent index
  // cannot establish that files belonging to a nested repository are untracked.
  for (const cwd of [row.outputPath, path.dirname(row.manifestPath)]) {
    const { stdout } = await runGitCommand(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { signal, timeout: 15_000 });
    if (await canonical(stdout.trim()) !== expected) throw new Error("Output repository changed");
  }
  const relative = path.relative(row.checkoutPath, row.outputPath).split(path.sep).join("/");
  const { stdout } = await runGitCommand(row.checkoutPath, ["ls-files", "-z", "--", `:(literal)${relative}`], { signal, timeout: 15_000 });
  if (stdout) throw new Error("Output contains tracked files");
  if (!await regular(row.manifestPath)) throw new Error("Cargo manifest is missing");
}

async function profileFolders(target: string): Promise<string[]> {
  const profiles: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const folder = path.join(target, entry.name);
    if (await regular(path.join(folder, ".cargo-lock"))) profiles.push(folder);
    else for (const child of await readdir(folder, { withFileTypes: true })) {
      if (child.isDirectory() && !child.isSymbolicLink()
        && await regular(path.join(folder, child.name, ".cargo-lock"))) profiles.push(path.join(folder, child.name));
    }
  }
  return profiles;
}

export async function scanCargoBuildOutputs(
  checkouts: string[],
  signal: AbortSignal,
  onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
  options: { helperPath?: string } = {},
): Promise<CargoBuildOutputDiscovery> {
  const result: CargoBuildOutputDiscovery = { items: [], kept: [] };
  const seen = new Set<string>();
  const roots = [...new Set(checkouts.map((value) => path.resolve(value)))];
  const scanCheckout = async (checkout: string) => {
    if (signal.aborted) return;
    let root: string;
    try { root = await realpath(checkout); } catch { return; }
    const queue = [root], targets: string[] = [], manifests: string[] = [];
    for (let index = 0; index < queue.length; index++) {
      if (signal.aborted) break;
      if (index >= MAX_SOURCE_FOLDERS) { result.kept.push({ path: root, reason: "Cargo discovery folder limit reached" }); break; }
      const folder = queue[index]!;
      onProgress?.({ detail: "Finding Cargo build profiles", root: folder, found: result.items.length });
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); }
      catch { result.kept.push({ path: folder, reason: "Cargo folder could not be read" }); continue; }
      if (entries.some((entry) => entry.name === "Cargo.toml" && entry.isFile())) manifests.push(path.join(folder, "Cargo.toml"));
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") continue;
        const child = path.join(folder, entry.name);
        try {
          if (await repositoryBoundary(child)) continue;
          if (await cargoTarget(child)) { targets.push(child); continue; }
          if (!SOURCE_SKIP.has(entry.name)) queue.push(child);
        } catch { result.kept.push({ path: child, reason: "Cargo folder could not be read" }); }
      }
    }
    if (!manifests.length) return;
    for (const target of targets) {
      let profiles: string[];
      try { profiles = await profileFolders(target); }
      catch { result.kept.push({ path: target, reason: "Cargo folder could not be read" }); continue; }
      for (const outputPath of profiles) {
        if (seen.has(outputPath)) continue;
        seen.add(outputPath);
        const manifestPath = manifests.filter((manifest) => target.startsWith(path.dirname(manifest) + path.sep))
          .sort((a, b) => b.length - a.length)[0] ?? manifests[0]!;
        const row: ThreadMaintenanceBuildOutput = { kind: "cargo", checkoutPath: root, outputPath, manifestPath };
        let lease: MaintenanceLock | undefined;
        try {
          const token = await identity(row);
          await assertUntracked(row, signal);
          lease = await acquireMaintenanceLock(path.join(outputPath, ".cargo-lock"), options.helperPath);
          if (!lease) { result.kept.push({ path: outputPath, reason: "Cargo build in progress" }); continue; }
          if (await identity(row) !== token) throw new Error("Output directory changed");
          lease.assertHeld();
          await lease.release();
          lease = undefined;
          const paths = await artifactPaths(outputPath, signal);
          if (!paths.length) continue;
          const space = await measureMaintenanceAllocationPaths(paths, signal);
          if (await identity(row) !== token) throw new Error("Output directory changed");
          result.items.push({ row: { ...row, ...(space ? { space } : {}) }, identity: token });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const reason = ["Output directory changed", "Output repository changed", "Nested Git repository in build output", "Cargo lock changed", "Output contains tracked files", "Cargo manifest is missing",
            "Native build lock verification unavailable", "Build lock could not be verified"].includes(message) ? message : "Cargo output could not be checked";
          result.kept.push({ path: outputPath, reason });
        } finally { await lease?.release(); }
      }
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < roots.length) {
      const root = roots[next++]!;
      try { await scanCheckout(root); }
      catch { result.kept.push({ path: root, reason: "Cargo checkout could not be read" }); }
    }
  }));
  return result;
}

/** Keep the profile and its lock inode, so a Cargo process starting during
 * cleanup cannot create a fresh lock and enter while this lease is held. */
export async function removeCargoBuildOutput(
  candidate: CargoBuildOutputCandidate,
  signal: AbortSignal,
  options: { helperPath?: string } = {},
): Promise<{ kept?: string; allocatedBytesRemoved?: number; alreadyGone?: boolean }> {
  const { row } = candidate;
  let lease: MaintenanceLock | undefined;
  try {
    if (await identity(row) !== candidate.identity) return { kept: "Output directory changed" };
    await assertUntracked(row, signal);
    lease = await acquireMaintenanceLock(path.join(row.outputPath, ".cargo-lock"), options.helperPath);
    if (!lease) return { kept: "Cargo build in progress" };
    if (await identity(row) !== candidate.identity) return { kept: "Output directory changed" };
    await assertUntracked(row, signal);
    const paths = await artifactPaths(row.outputPath, signal);
    const space = await measureMaintenanceAllocationPaths(paths, signal);
    for (const file of paths) {
      if (signal.aborted) return { kept: "Stopped before removing" };
      lease.assertHeld();
      if (await identity(row) !== candidate.identity) return { kept: "Output directory changed" };
      if ((await lstat(file)).isDirectory()) await assertNoNestedRepository(file, signal);
      await rm(file, { recursive: true, force: true });
    }
    return { ...(space?.allocatedBytes !== undefined ? { allocatedBytesRemoved: space.allocatedBytes } : {}) };
  } catch (error) {
    if (error instanceof Error && ["Output repository changed", "Nested Git repository in build output"].includes(error.message)) return { kept: error.message };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try { await lstat(row.outputPath); return { kept: "Output directory changed" }; }
      catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") return { alreadyGone: true }; throw missing; }
    }
    throw error;
  } finally { await lease?.release(); }
}
