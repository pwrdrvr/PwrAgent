import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadHandoffPackage } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import { validateHandoffFilePaths } from "../federation/thread-handoff-package";

type GitSnapshot = NonNullable<ThreadHandoffPackage["git"]>;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string) {
  return runGitCommand(cwd, args, { env, input, maxBuffer: 16 * 1024 * 1024 });
}

function blobHash(bytes: Buffer, head: string): string {
  return createHash(head.length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function quoteGitPath(file: string): string {
  const quoted = Array.from(file, (char) => {
    if (char === "\\" || char === "\"") return `\\${char}`;
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? `\\${code.toString(8).padStart(3, "0")}` : char;
  }).join("");
  return `"${quoted}"`;
}

/** Build two private commits without touching the source checkout or index. */
export async function exportGitHandoff(cwd: string, staging: string, receiverCommits: string[] = []): Promise<GitSnapshot> {
  const head = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  if (!Array.isArray(receiverCommits) || receiverCommits.length > 256
    || receiverCommits.some((oid) => typeof oid !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid))) {
    throw new Error("Invalid receiver Git inventory.");
  }
  let sharedBase: string | undefined;
  if (receiverCommits.length) {
    const objects = (await git(cwd, ["cat-file", "--batch-check"], undefined, receiverCommits.join("\n") + "\n")).stdout.trim().split("\n");
    const sharedCommit = objects.find((entry) => entry.split(" ")[1] === "commit")?.split(" ")[0];
    if (sharedCommit) sharedBase = (await git(cwd, ["merge-base", head, sharedCommit]).catch(() => ({ stdout: "" }))).stdout.trim() || undefined;
  }
  const sourceBranch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => ({ stdout: "" }))).stdout.trim();
  const status = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const index = path.join(staging, "index");
  const indexPath = (await git(cwd, ["rev-parse", "--git-path", "index"])).stdout.trim();
  await copyFile(path.resolve(cwd, indexPath), index);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "PwrAgent handoff",
    GIT_AUTHOR_EMAIL: "handoff@pwragent.invalid",
    GIT_COMMITTER_NAME: "PwrAgent handoff",
    GIT_COMMITTER_EMAIL: "handoff@pwragent.invalid",
  };
  const indexEntries = (await git(cwd, ["ls-files", "--stage", "-z"], env)).stdout;
  if (indexEntries.split("\0").some((entry) => entry && !/^100(?:644|755) [0-9a-f]+ 0\t/.test(entry))) {
    throw new Error("Handoff currently requires regular files and a resolved index; submodules and symlinks are unsupported.");
  }
  const indexTree = (await git(cwd, ["write-tree"], env)).stdout.trim();
  const indexCommit = (await git(cwd, ["commit-tree", indexTree, "-p", head, "-m", "PwrAgent staged state"], env)).stdout.trim();
  const files = (await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], env)).stdout;
  const fingerprints = new Map<string, string>();
  const payloadFiles: GitSnapshot["files"] = [];
  const indexUpdates: string[] = [];
  let payloadBytes = 0;
  const fileMode = (await git(cwd, ["config", "--get", "core.filemode"])
    .catch(() => ({ stdout: process.platform === "win32" ? "false" : "true" }))).stdout.trim() === "true";
  const modes = new Map(indexEntries.split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    return [entry.slice(tab + 1), entry.slice(0, 6)];
  }));
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    const absolute = path.resolve(cwd, file);
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      indexUpdates.push(`0 ${"0".repeat(head.length)}\t${file}\0`);
      fingerprints.set(file, "deleted");
      continue;
    }
    if (!info.isFile()) throw new Error(`Handoff requires a regular file: ${file}`);
    // Bypass clean filters and line-ending conversion: preserve actual bytes.
    payloadBytes += info.size;
    if (payloadBytes > MAX_BUNDLE_BYTES) throw new Error("Workspace files exceed the 128 MiB handoff limit.");
    const bytes = await readFile(absolute);
    const oid = blobHash(bytes, head);
    const mode = fileMode || !modes.has(file)
      ? ((info.mode & 0o111) ? "100755" : "100644")
      : modes.get(file) as "100644" | "100755";
    indexUpdates.push(`${mode} ${oid}\t${file}\0`);
    payloadFiles.push({ path: file, dataBase64: bytes.toString("base64"), mode });
    fingerprints.set(file, oid);
  }
  const inputPaths = payloadFiles.map((file) => quoteGitPath(file.path)).join("\n") + "\n";
  if (payloadFiles.length) {
    const hashes = (await git(cwd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], undefined, inputPaths)).stdout.trim().split("\n");
    if (hashes.length !== payloadFiles.length || payloadFiles.some((file, i) => hashes[i] !== fingerprints.get(file.path))) {
      throw new Error("Source files changed during handoff. Retry after edits settle.");
    }
  }
  if (indexUpdates.length) await git(cwd, ["update-index", "-z", "--index-info"], env, indexUpdates.join(""));
  const workingTree = (await git(cwd, ["write-tree"], env)).stdout.trim();
  const workingCommit = (await git(cwd, ["commit-tree", workingTree, "-p", indexCommit, "-m", "PwrAgent working state"], env)).stdout.trim();
  const ref = `refs/pwragent/handoffs/${randomUUID()}`;
  const bundle = path.join(staging, "workspace.bundle");
  await git(cwd, ["update-ref", ref, workingCommit]);
  try {
    await git(cwd, ["bundle", "create", bundle, ref, ...(sharedBase ? [`^${sharedBase}`] : [])]);
    const size = (await lstat(bundle)).size;
    if (size > MAX_BUNDLE_BYTES) throw new Error("The Git handoff bundle exceeds 128 MiB.");
    if (payloadFiles.length) {
      const hashes = (await git(cwd, ["hash-object", "--no-filters", "--stdin-paths"], undefined, inputPaths)).stdout.trim().split("\n");
      if (hashes.length !== payloadFiles.length || payloadFiles.some((file, i) => hashes[i] !== fingerprints.get(file.path))) {
        throw new Error("Source files changed during handoff. Retry after edits settle.");
      }
    }
    const currentHead = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const currentStatus = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    const currentIndex = (await git(cwd, ["ls-files", "--stage", "-z"])).stdout;
    if (currentHead !== head || currentStatus !== status || currentIndex !== indexEntries) {
      throw new Error("Source Git state changed during handoff. Retry after edits settle.");
    }
    return { head, indexCommit, workingCommit, files: payloadFiles, bundleBase64: (await readFile(bundle)).toString("base64"), ...(sourceBranch ? { sourceBranch } : {}) };
  } finally {
    await git(cwd, ["update-ref", "-d", ref]);
    await rm(index, { force: true });
  }
}

/** Import into a new, detached worktree. Existing branches are never moved. */
export async function importGitHandoff(params: {
  repository: string;
  worktree: string;
  bundlePath: string;
  snapshot: GitSnapshot;
}): Promise<() => Promise<void>> {
  const { repository, worktree, bundlePath, snapshot } = params;
  validateHandoffFilePaths(snapshot.files);
  const destinationRoots = (await git(repository, ["rev-list", "--max-parents=0", "HEAD"])).stdout.trim().split("\n");
  const ref = `refs/pwragent/handoffs/${randomUUID()}`;
  let created = false;
  const rollback = async () => {
    if (created) await git(repository, ["worktree", "remove", "--force", worktree]);
  };
  await git(repository, ["bundle", "verify", bundlePath]);
  const refs = (await git(repository, ["bundle", "list-heads", bundlePath])).stdout.trim().split("\n");
  if (refs.length !== 1 || refs[0].split(" ")[0] !== snapshot.workingCommit
    || !/^refs\/pwragent\/handoffs\/[0-9a-f-]{36}$/.test(refs[0].split(" ")[1])) {
    throw new Error("Git bundle does not match the handoff manifest.");
  }
  try {
    await git(repository, ["-c", "core.hooksPath=", "fetch", "--no-tags", "--no-write-fetch-head", bundlePath, `${refs[0].split(" ")[1]}:${ref}`]);
    const sourceRoots = (await git(repository, ["rev-list", "--max-parents=0", snapshot.head])).stdout.trim().split("\n");
    if (!sourceRoots.some((root) => destinationRoots.includes(root))) throw new Error("The chosen receiver repository has unrelated Git history.");
    const parent = (await git(repository, ["rev-parse", `${ref}^`, `${ref}^^`])).stdout.trim().split("\n");
    if (parent[0] !== snapshot.indexCommit || parent[1] !== snapshot.head) throw new Error("Git snapshot ancestry did not match.");
    await git(repository, ["-c", "core.hooksPath=", "worktree", "add", "--no-checkout", "--detach", worktree, snapshot.head]);
    created = true;
    // Materialize raw bytes without invoking receiver clean/smudge filters.
    const treeEntries = new Map((await git(repository, ["ls-tree", "-r", "-z", snapshot.workingCommit])).stdout
      .split("\0").filter(Boolean).map((entry) => {
        const tab = entry.indexOf("\t");
        return [entry.slice(tab + 1), entry.slice(0, tab)];
      }));
    if (treeEntries.size !== snapshot.files.length) throw new Error("Workspace file count did not match the bundle.");
    for (const file of snapshot.files) {
      const destination = path.join(worktree, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      const content = Buffer.from(file.dataBase64, "base64");
      await writeFile(destination, content, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
      if (process.platform !== "win32") await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
      const hash = blobHash(content, snapshot.head);
      if (treeEntries.get(file.path) !== `${file.mode} blob ${hash}`) throw new Error("Workspace file bytes did not match the bundle.");
      treeEntries.delete(file.path);
    }
    if (treeEntries.size) throw new Error("Workspace files were missing from the package.");
    await git(worktree, ["read-tree", snapshot.indexCommit]);
    return rollback;
  } catch (error) {
    await rollback();
    throw error;
  } finally {
    await git(repository, ["update-ref", "-d", ref]);
  }
}
