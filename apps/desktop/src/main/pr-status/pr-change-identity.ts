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
  options: { timeout: number; maxBuffer?: number; input?: string },
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

  /** Undefined when Git cannot say: the commit is missing, or the diff is too large. */
  async changeIdentity(params: {
    cwd: string;
    sha: string;
    targetTip: string;
  }): Promise<string | undefined> {
    const sha = params.sha.toLowerCase();
    if (!GIT_OBJECT_ID.test(sha) || !GIT_OBJECT_ID.test(params.targetTip)) return undefined;
    const key = `${params.targetTip.toLowerCase()}\u0000${sha}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      // Refresh recency.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached ?? undefined;
    }
    const identity = await this.computeIdentity(params.cwd, sha, params.targetTip);
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

  private async computeIdentity(cwd: string, sha: string, targetTip: string): Promise<string | undefined> {
    try {
      const { stdout: mergeBase } = await this.git(cwd, ["merge-base", targetTip, sha]);
      const base = mergeBase.trim();
      if (!GIT_OBJECT_ID.test(base)) return undefined;
      const { stdout: diff } = await this.git(
        cwd,
        ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", base, sha],
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
