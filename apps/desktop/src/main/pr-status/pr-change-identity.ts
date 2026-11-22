import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGitCommand } from "../app-server/git-executable";
import { runPrMetadataGit } from "./pr-metadata-process";

const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GIT_TIMEOUT_MS = 15_000;
/** A PR diff past this is not compared; its head reads as a new change. */
const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const CACHE_LIMIT = 256;
/** Patch-id of an empty diff: Git prints nothing. */
const EMPTY_CHANGE = "empty";

export type PrChangeGitRunner = (
  cwd: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; input?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const defaultRunner: PrChangeGitRunner = async (cwd, args, options) =>
  await runPrMetadataGit(cwd, args, { ...options, purpose: "pr-review-coverage" });

/**
 * The identity of the change a pull request head proposes: `git patch-id
 * --stable` of the head's whole diff against its merge base with the target
 * branch. It is what `git cherry` and `git range-diff` compare.
 *
 * Two heads with the same identity carry the same change. Rebasing onto a
 * newer target and merging the target in both keep it: the diff starts from
 * the new merge base, patch-id ignores line numbers, and the diff carries no
 * context lines (`-U0`), so a target edit next to a changed line does not
 * count as a change. Any edit to the change itself, including resolving a
 * conflict differently, moves it. The cost of `-U0` is that moving an
 * identical added line elsewhere in the same file keeps the identity.
 *
 * Each head costs three Git processes (merge-base, diff, patch-id) per
 * target tip, then reads from a bounded cache keyed by target tip and commit.
 * Keying by tip, not by branch name, means an identity read against a stale
 * target ref is not reused once the ref moves.
 */
/** What the review-offer coordinator reads from Git; tests supply their own. */
export type PrChangeIdentitySource = Pick<
  PrChangeIdentityReader,
  "gitProcessCount" | "resolveTargetTip" | "changeIdentity" | "readReviewedBranchHead"
>;

export class PrChangeIdentityReader {
  private readonly cache = new Map<string, string | null>();
  private gitCalls = 0;

  constructor(private readonly run: PrChangeGitRunner = defaultRunner) {}

  /** Git processes started, for measurement. */
  get gitProcessCount(): number {
    return this.gitCalls;
  }

  /**
   * The commit the target branch points at, as this checkout knows it. The
   * forge's own base SHA wins when the checkout has it; otherwise a
   * remote-tracking branch of the same name, then a local one.
   */
  async resolveTargetTip(params: {
    cwd: string;
    baseSha?: string;
    baseRefName?: string;
  }): Promise<string | undefined> {
    if (params.baseSha && GIT_OBJECT_ID.test(params.baseSha)) {
      if (await this.commitExists(params.cwd, params.baseSha)) return params.baseSha.toLowerCase();
    }
    const branch = params.baseRefName?.trim();
    if (!branch || branch.startsWith("-")) return undefined;
    let stdout: string;
    try {
      ({ stdout } = await this.git(params.cwd, [
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        `refs/remotes/upstream/${branch}`,
        `refs/remotes/origin/${branch}`,
        `refs/heads/${branch}`,
      ]));
    } catch {
      return undefined;
    }
    const refs = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const [sha, ref] = line.trim().split(" ");
      if (sha && ref && GIT_OBJECT_ID.test(sha)) refs.set(ref, sha.toLowerCase());
    }
    return refs.get(`refs/remotes/upstream/${branch}`)
      ?? refs.get(`refs/remotes/origin/${branch}`)
      ?? refs.get(`refs/heads/${branch}`);
  }

  /**
   * Undefined when Git cannot say: the commit or tree is missing, or the diff
   * is too large. With `tree`, the change is that tree's content on top of
   * `sha`: the working tree a review of uncommitted changes saw, which
   * `captureReviewedWorkingTree` recorded.
   */
  async changeIdentity(params: {
    cwd: string;
    sha: string;
    tree?: string;
    targetTip: string;
  }): Promise<string | undefined> {
    const sha = params.sha.toLowerCase();
    const tree = params.tree?.toLowerCase();
    if (!GIT_OBJECT_ID.test(sha) || !GIT_OBJECT_ID.test(params.targetTip)) return undefined;
    if (tree !== undefined && !GIT_OBJECT_ID.test(tree)) return undefined;
    const key = `${params.targetTip.toLowerCase()}\u0000${sha}${tree ? `\u0000${tree}` : ""}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      // Refresh recency.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached ?? undefined;
    }
    const identity = await this.computeIdentity(params.cwd, sha, tree ?? sha, params.targetTip);
    // A missing commit may be fetched later, so only answers are cached.
    if (identity !== undefined) {
      this.cache.set(key, identity);
      if (this.cache.size > CACHE_LIMIT) {
        this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return identity;
  }

  /**
   * The checkout's HEAD when it still holds the reviewed work: it is on the
   * reviewed branch, or, for a review of a detached checkout, descends from
   * the reviewed commit. A rebase between review and fix keeps the branch,
   * so the branch decides when the review named one.
   */
  async readReviewedBranchHead(
    cwd: string,
    reviewed: { sha: string; branch?: string },
  ): Promise<string | undefined> {
    if (!GIT_OBJECT_ID.test(reviewed.sha)) return undefined;
    try {
      const { stdout } = await this.git(cwd, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]);
      const [sha, branch] = stdout.trim().split(/\r?\n/);
      const head = sha?.trim().toLowerCase();
      if (!head || !GIT_OBJECT_ID.test(head)) return undefined;
      if (reviewed.branch) return branch?.trim() === reviewed.branch ? head : undefined;
      if (head === reviewed.sha.toLowerCase()) return head;
      await this.git(cwd, ["merge-base", "--is-ancestor", reviewed.sha, head]);
      return head;
    } catch {
      return undefined;
    }
  }

  private async computeIdentity(
    cwd: string,
    sha: string,
    content: string,
    targetTip: string,
  ): Promise<string | undefined> {
    try {
      const { stdout: mergeBase } = await this.git(cwd, ["merge-base", targetTip, sha]);
      const base = mergeBase.trim();
      if (!GIT_OBJECT_ID.test(base)) return undefined;
      const { stdout: diff } = await this.git(
        cwd,
        ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", base, content],
        { maxBuffer: MAX_DIFF_BYTES },
      );
      if (diff.length === 0) return EMPTY_CHANGE;
      const { stdout } = await this.git(cwd, ["patch-id", "--stable"], { input: diff });
      const patchId = stdout.trim().split(/\s+/)[0];
      return patchId && GIT_OBJECT_ID.test(patchId) ? patchId.toLowerCase() : EMPTY_CHANGE;
    } catch {
      return undefined;
    }
  }

  private async commitExists(cwd: string, sha: string): Promise<boolean> {
    try {
      await this.git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async git(
    cwd: string,
    args: string[],
    extra: { maxBuffer?: number; input?: string } = {},
  ): Promise<{ stdout: string }> {
    this.gitCalls += 1;
    return await this.run(cwd, args, { timeout: GIT_TIMEOUT_MS, ...extra });
  }
}

const defaultTreeRunner: PrChangeGitRunner = async (cwd, args, options) =>
  await runGitCommand(cwd, args, { ...options, purpose: "review-working-tree" });

/** What a capture may hash; past either, it records nothing. */
export type ReviewedTreeLimits = { maxBytes: number; maxFiles: number };

const REVIEWED_TREE_LIMITS: ReviewedTreeLimits = {
  // A larger change has no identity anyway.
  maxBytes: MAX_DIFF_BYTES,
  maxFiles: 5_000,
};
const MAX_LISTING_BYTES = 8 * 1024 * 1024;

/**
 * The tree a commit of everything in the checkout would record right now,
 * staged, unstaged, and untracked files Git does not ignore, with the HEAD it
 * sits on. Undefined when the checkout has no uncommitted changes, when they
 * are past `limits`, or when Git cannot say.
 *
 * It stages into a copy of the checkout's index under `GIT_INDEX_FILE`, so
 * the operator's index, stash list, and refs are untouched. The copy keeps
 * Git's cached file stats, so only changed files are hashed, and the limits
 * are checked before any is. The blobs and tree it writes are unreachable
 * objects, which `git gc` prunes after its usual grace period. Four Git
 * processes.
 */
export async function captureReviewedWorkingTree(
  cwd: string,
  run: PrChangeGitRunner = defaultTreeRunner,
  limits: ReviewedTreeLimits = REVIEWED_TREE_LIMITS,
): Promise<{ head: string; tree: string } | undefined> {
  let scratch: string | undefined;
  try {
    // One read, so the tree and the HEAD it is recorded against agree.
    const { stdout } = await run(cwd, [
      "rev-parse", "--show-toplevel", "--git-path", "index", "HEAD", "HEAD^{tree}",
    ], { timeout: GIT_TIMEOUT_MS });
    const [top, indexPath, head, headTree] = stdout.trim().split(/\r?\n/).map((line) => line.trim());
    if (!top || !indexPath || !head || !headTree) return undefined;
    if (!GIT_OBJECT_ID.test(head) || !GIT_OBJECT_ID.test(headTree)) return undefined;
    // What `add` would hash: untracked files and tracked files changed since
    // the index. Staged content is already in the object store.
    const { stdout: listed } = await run(top, [
      "ls-files", "-z", "--others", "--modified", "--exclude-standard",
    ], { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_LISTING_BYTES });
    const paths = new Set(listed.split("\0").filter(Boolean));
    if (paths.size > limits.maxFiles) return undefined;
    let bytes = 0;
    for (const relative of paths) {
      // A deleted file is listed as modified and has nothing to hash.
      const stats = await lstat(path.join(top, relative)).catch(() => undefined);
      bytes += stats?.isFile() ? stats.size : 0;
      if (bytes > limits.maxBytes) return undefined;
    }
    scratch = await mkdtemp(path.join(os.tmpdir(), "pwragent-review-tree-"));
    const index = path.join(scratch, "index");
    try {
      await copyFile(path.resolve(cwd, indexPath), index);
    } catch (error) {
      // A checkout with nothing staged yet has no index, and `add` starts
      // one. Any other failure would rehash every file, so give up.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
    await run(cwd, ["add", "--all", "--", ":/"], { timeout: GIT_TIMEOUT_MS, env });
    const { stdout: treeOut } = await run(cwd, ["write-tree"], { timeout: GIT_TIMEOUT_MS, env });
    const tree = treeOut.trim().toLowerCase();
    if (!GIT_OBJECT_ID.test(tree) || tree === headTree.toLowerCase()) return undefined;
    return { head: head.toLowerCase(), tree };
  } catch {
    return undefined;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
