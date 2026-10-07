import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ThreadHandoffGitReference } from "@pwragent/shared";
import { normalizeGitOriginUrl } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import { validateGitHandoffReference } from "../federation/thread-handoff-package";

function git(cwd: string, args: string[]) {
  return runGitCommand(cwd, args, { maxBuffer: 1024 * 1024 });
}

/** Same identity for SSH/HTTPS clones, without transmitting credentials. */
export function handoffRepositoryIdentity(remote: string): string | undefined {
  let value = remote;
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    value = url.toString();
  } catch {
    value = remote.replace(/^[^@/]+@([^:]+):(.+)$/, "$1/$2");
  }
  return normalizeGitOriginUrl(value);
}

async function assertClean(cwd: string): Promise<void> {
  const status = (await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout;
  if (status) throw new Error("Commit or stash your non-ignored workspace changes before handing off this thread, then push the commit.");
}

/** Only a published reference is transferred. Git owns all workspace bytes. */
export async function exportGitHandoff(cwd: string): Promise<ThreadHandoffGitReference> {
  await assertClean(cwd);
  const head = (await git(cwd, ["rev-parse", "HEAD"]).catch((error: unknown) => {
    throw new Error("Create and push the repository's first commit before handing off this thread.", { cause: error });
  })).stdout.trim();
  const sourceBranch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => ({ stdout: "" }))).stdout.trim();
  const remote = sourceBranch
    ? (await git(cwd, ["config", "--get", `branch.${sourceBranch}.remote`]).catch(() => ({ stdout: "origin" }))).stdout.trim()
    : "origin";
  if (!remote || remote === ".") throw new Error("Push this branch to a shared Git remote before handing off the thread.");
  const url = (await git(cwd, ["remote", "get-url", remote]).catch(() => ({ stdout: "" }))).stdout.trim();
  const origin = handoffRepositoryIdentity(url);
  if (!origin) throw new Error("Configure a shared Git remote and push this branch before handing off the thread.");
  const branchRef = sourceBranch
    ? (await git(cwd, ["config", "--get", `branch.${sourceBranch}.merge`])
      .catch(() => ({ stdout: `refs/heads/${sourceBranch}` }))).stdout.trim()
    : undefined;
  const published = (await git(cwd, ["ls-remote", "--heads", remote, ...(branchRef ? [branchRef] : [])])).stdout
    .trim().split("\n").map((line) => line.split(/\s+/));
  const advertised = published.find(([oid, name]) => branchRef ? name === branchRef : oid === head);
  const ref = advertised?.[1];
  if (!ref) {
    throw new Error(sourceBranch
      ? `Push branch ${sourceBranch} to ${remote} before handing off.`
      : "Publish the detached source commit on a remote branch before handing off the thread.");
  }
  const snapshot = { head, ref, origin, ...(sourceBranch ? { sourceBranch } : {}) };
  validateGitHandoffReference(snapshot);
  // A published branch may have advanced beyond this checkout. Fetching its
  // history proves whether HEAD was pushed without moving the local branch.
  if (advertised?.[0] !== head) {
    await prepareGitHandoff(cwd, snapshot).catch((error: unknown) => {
      throw new Error(`Push branch ${sourceBranch} to ${remote} before handing off. Its published history must contain the source commit.`, { cause: error });
    });
  }
  await assertGitHandoffUnchanged(cwd, snapshot);
  return snapshot;
}

export async function assertGitHandoffUnchanged(cwd: string, snapshot: ThreadHandoffGitReference): Promise<void> {
  await assertClean(cwd);
  if ((await git(cwd, ["rev-parse", "HEAD"])).stdout.trim() !== snapshot.head) {
    throw new Error("Source Git state changed during handoff. Retry after edits settle.");
  }
}

/** Fetch only from a receiver-configured remote belonging to the same repo. */
async function withFetchedHandoff<T>(repository: string, snapshot: ThreadHandoffGitReference, work: () => Promise<T>): Promise<T> {
  validateGitHandoffReference(snapshot);
  await git(repository, ["rev-parse", "--show-toplevel"]).catch((error: unknown) => {
    throw new Error("The repository is not available on the receiving machine. Clone it there and choose its path before handing off.", { cause: error });
  });
  await git(repository, ["check-ref-format", snapshot.ref]);
  const remotes = (await git(repository, ["remote"])).stdout.trim().split("\n").filter(Boolean);
  let remote: string | undefined;
  for (const name of remotes) {
    const url = (await git(repository, ["remote", "get-url", name])).stdout.trim();
    if (handoffRepositoryIdentity(url) === snapshot.origin) { remote = name; break; }
  }
  if (!remote) throw new Error("The receiving repository has no remote matching the sender. Clone the same repository or fix its remote before handing off.");
  const ref = `refs/pwragent/handoffs/${randomUUID()}`;
  try {
    await git(repository, ["-c", "core.hooksPath=", "fetch", "--no-tags", "--no-write-fetch-head", "--", remote, `${snapshot.ref}:${ref}`])
      .catch((error: unknown) => {
        throw new Error(`The receiving machine could not fetch ${snapshot.ref}. Check its Git access and push the source branch before handing off.`, { cause: error });
      });
    const fetchedHead = (await git(repository, ["rev-parse", `${ref}^{commit}`])).stdout.trim();
    const published = fetchedHead === snapshot.head || await git(repository, ["merge-base", "--is-ancestor", snapshot.head, fetchedHead])
      .then(() => true, () => false);
    if (!published) {
      throw new Error("The published branch no longer contains the source commit. Push it before handing off, or retry after a branch rewrite.");
    }
    return await work();
  } finally {
    await git(repository, ["update-ref", "-d", ref]);
  }
}

export async function prepareGitHandoff(repository: string, snapshot: ThreadHandoffGitReference): Promise<{ head: string }> {
  return await withFetchedHandoff(repository, snapshot, async () => ({ head: snapshot.head }));
}

/** Create a new detached checkout without moving a receiver branch or index. */
export async function importGitHandoff(params: {
  repository: string;
  worktree: string;
  snapshot: ThreadHandoffGitReference;
}): Promise<() => Promise<void>> {
  const { repository, worktree, snapshot } = params;
  let created = false;
  const rollback = async () => { if (created) await git(repository, ["worktree", "remove", "--force", worktree]); };
  try {
    return await withFetchedHandoff(repository, snapshot, async () => {
      await git(repository, ["-c", "core.hooksPath=", "worktree", "add", "--detach", worktree, snapshot.head]);
      created = true;
      const cwd = snapshot.cwdRelative ? path.join(worktree, ...snapshot.cwdRelative.split("/")) : worktree;
      // Validate the Git-owned directory before returning the checkout to the
      // caller. Never create a missing path or follow a link outside the tree.
      const relative = path.relative(await realpath(worktree), await realpath(cwd));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(cwd)).isDirectory()) {
        throw new Error("The imported thread directory must be inside its new workspace.");
      }
      return rollback;
    });
  } catch (error) {
    await rollback();
    throw error;
  }
}
