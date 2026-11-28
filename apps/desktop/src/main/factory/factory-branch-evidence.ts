import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import { buildThreadUrl, isThreadLinkId } from "@pwragent/shared/contracts/thread-link";
import type { FactoryBranchProjection, FactoryBranchSelection, FactoryReceiptProjection } from "@pwragent/shared/factory-projection";
import { factoryWorkItemKey, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import { runGitCommand } from "../app-server/git-executable";
import { getProcessRuntimeIdentity, resolveActiveProfileName } from "../profile";
import { resolveGitHubFetchUrl } from "../pr-status/git-remote";

type ReviewLookup = (id: string) => ThreadReview | undefined;

export function isFactoryBranchName(branch: string): boolean {
  return !!branch && !branch.startsWith("refs/");
}

export function isFactoryIntegrationRef(ref: string): boolean {
  return /^refs\/(?:heads\/.+|remotes\/[^/]+\/.+)$/.test(ref);
}

async function git(cwd: string, args: string[], maxBuffer = 32_768): Promise<string | undefined> {
  // Owner observations address the selected checkout, not a caller's Git index or object store.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return (await runGitCommand(cwd, args, {
    env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" }, timeout: 3_000, maxBuffer,
  }).catch(() => undefined))?.stdout.trim();
}

async function checkout(directory: string) {
  const localPath = await realpath(directory).catch(() => undefined);
  if (!localPath) return;
  const result = await git(localPath, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  const [root, common] = result?.split(/\r?\n/) ?? [];
  if (!root || !common || await realpath(root).catch(() => undefined) !== localPath) return;
  const realCommon = await realpath(common).catch(() => undefined);
  return realCommon ? { path: localPath, common: realCommon } : undefined;
}

async function readGitHubRemote(root: string, name: string) {
  const url = await git(root, ["remote", "get-url", "--", name]);
  return url ? resolveGitHubFetchUrl(url) : undefined;
}

export function readFactoryOrigin(root: string) {
  return readGitHubRemote(root, "origin");
}

async function readRef(root: string, ref: string) {
  if (await git(root, ["check-ref-format", ref]) === undefined) throw new Error("Select a valid Factory Git ref.");
  const value = await git(root, ["for-each-ref", "--count=1", "--format=%(refname) %(objecttype) %(objectname) %(symref)", "--", ref]);
  const [name, type, oid, target] = value?.split(" ") ?? [];
  return name === ref && type === "commit" && oid && isGitObjectId(oid) ? { oid, ref: target || ref } : undefined;
}

function refspecMatch(pattern: string, ref: string): string | undefined {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return pattern === ref ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (ref.length >= prefix.length + suffix.length && ref.startsWith(prefix) && ref.endsWith(suffix)) {
    return ref.slice(prefix.length, ref.length - suffix.length);
  }
  return undefined;
}

function trackingSource(config: string, ref: string) {
  const negatives = new Map<string, string[]>();
  let match: { remote: string; source: string } | undefined;
  for (const row of config.split("\0")) {
    const entry = /^remote\.(.+)\.fetch\n(.+)$/.exec(row);
    if (!entry) continue;
    const [, remote, spec] = entry;
    if (spec.startsWith("^")) {
      let patterns = negatives.get(remote);
      if (!patterns) negatives.set(remote, patterns = []);
      patterns.push(spec.slice(1));
      continue;
    }
    const mapping = /^\+?([^:\s]+):([^:\s]+)$/.exec(spec);
    if (!mapping) continue;
    const [, source, destination] = mapping;
    const captured = refspecMatch(destination, ref);
    if (captured === undefined) continue;
    const mapped = source.replace("*", () => captured);
    if (source.includes("*") !== destination.includes("*") || mapped.includes("*")) return undefined;
    // Several sources may have written this ref, even if a source is now excluded.
    if (match && (match.remote !== remote || match.source !== mapped)) return undefined;
    match = { remote, source: mapped };
  }
  if (!match) return undefined;
  const { remote, source } = match;
  return negatives.get(remote)?.some((pattern) => refspecMatch(pattern, source) !== undefined) ? undefined : match;
}

export async function readFactoryIntegrationTarget(root: string, ref: string, repository: string) {
  const tip = await readRef(root, ref);
  if (!tip) return undefined;
  if (ref.startsWith("refs/heads/") && tip.ref.startsWith("refs/heads/")) {
    return { oid: tip.oid, branch: tip.ref.slice("refs/heads/".length) };
  }
  const config = await git(root, ["config", "--null", "--get-regexp", "^remote\\..*\\.fetch$"]);
  const tracking = config && trackingSource(config, tip.ref);
  const branch = tracking && /^refs\/heads\/(.+)$/.exec(tracking.source)?.[1];
  if (!tracking || !branch) return undefined;
  const remote = await readGitHubRemote(root, tracking.remote);
  if (!remote || `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase() !== repository.toLowerCase()) return undefined;
  return { oid: tip.oid, branch };
}

export type FactoryCleanCandidate =
  | { state: "clean"; headOid: string; baseOid: string; baseBranch: string }
  | { state: "dirty" | "unverified" };

/** Sample the approved linked worktree. Ref drift during the clean check fails closed. */
export async function readFactoryCleanCandidate(
  projectPath: string, repository: string, selection: Pick<FactoryBranchSelection, "branch" | "baseRef">, worktreePath: string,
): Promise<FactoryCleanCandidate> {
  const [project, worktree] = await Promise.all([checkout(projectPath), checkout(worktreePath)]);
  if (!project || !worktree || project.common !== worktree.common || project.path === worktree.path) return { state: "unverified" };
  const branchRef = `refs/heads/${selection.branch}`;
  const repositoryKey = `github.com/${repository}`;
  const sample = async () => {
    const [projectOrigin, worktreeOrigin, branch, head, base] = await Promise.all([
      readFactoryOrigin(project.path),
      readFactoryOrigin(worktree.path),
      git(worktree.path, ["symbolic-ref", "--quiet", "HEAD"]),
      readRef(worktree.path, branchRef),
      readFactoryIntegrationTarget(project.path, selection.baseRef, repositoryKey),
    ]);
    const originMatches = [projectOrigin, worktreeOrigin].every((remote) =>
      remote && `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase() === repositoryKey.toLowerCase());
    return originMatches && branch === branchRef && head && base && head.oid.length === base.oid.length
      ? { headOid: head.oid, baseOid: base.oid, baseBranch: base.branch } : undefined;
  };
  const before = await sample();
  if (!before) return { state: "unverified" };
  const state = await readWorktreeState(worktree.path);
  if (state !== "clean") return { state };
  const after = await sample();
  return after?.headOid === before.headOid && after.baseOid === before.baseOid && after.baseBranch === before.baseBranch
    ? { state: "clean", ...after } : { state: "unverified" };
}

async function readWorktreeState(worktree: string): Promise<"dirty" | "unverified" | "clean"> {
  const [status, index] = await Promise.all([
    git(worktree, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"]),
    git(worktree, ["ls-files", "-v", "-z"], 2 * 1024 * 1024),
  ]);
  if (status) return "dirty";
  // Git status skips paths marked assume-unchanged or skip-worktree.
  return status === undefined || index === undefined || /(?:^|\0)[a-zS] /.test(index) ? "unverified" : "clean";
}


async function checkoutIdentity(directory: string): Promise<string | undefined> {
  if (!isAbsolute(directory)) return undefined;
  const info = await stat(directory, { bigint: true }).catch(() => undefined);
  if (!info?.isDirectory()) return undefined;
  return info.ino ? `${info.dev}:${info.ino}` : realpath(directory).catch(() => undefined);
}

async function reviewReceipt(
  review: ThreadReview | undefined, matchesCheckout: (directory: string) => Promise<boolean>, branch: string,
): Promise<FactoryReceiptProjection | undefined> {
  const context = review?.context;
  if (review?.origin !== "automatic" || !context
    || !isThreadLinkId(review.threadId) || context.gitBranch !== branch || context.reviewedTree
    || context.pullRequest || context.pullRequests?.length) return;
  if (!context.headCommit || !isGitObjectId(context.headCommit) || !context.baseCommit || !isGitObjectId(context.baseCommit)) return;
  if (!await matchesCheckout(context.workspacePath)
    && (!context.repositoryPath || !await matchesCheckout(context.repositoryPath))) return;
  const reference = buildThreadUrl({
    threadId: review.threadId, backend: review.backend,
    messageId: isThreadLinkId(review.sourceKey) ? review.sourceKey : undefined,
  });
  return {
    // The recorded commits describe the checkout at review start. A base-branch
    // reviewer can see staged and unstaged changes that differ from that range.
    kind: "review", source: "owner_review", name: review.id, reference,
    status: review.status === "open" || review.items.some((item) => item.status === "open") ? "pending" : "inconclusive",
  };
}

export async function readFactoryBranchRevision(
  projectPath: string, repository: string, selection: FactoryBranchSelection,
) {
  const project = await checkout(projectPath);
  if (!project) throw new Error("The registered Factory project checkout could not be verified.");
  const worktree = selection.worktree ? await checkout(selection.worktree) : undefined;
  if (worktree && worktree.common !== project.common) throw new Error("The Factory worktree belongs to a different project.");
  const branchRef = `refs/heads/${selection.branch}`;
  const [head, base, checkedOut] = await Promise.all([
    readRef(project.path, branchRef),
    readFactoryIntegrationTarget(project.path, selection.baseRef, repository),
    worktree ? git(worktree.path, ["symbolic-ref", "--quiet", "HEAD"]) : undefined,
  ]);
  const headOid = head?.oid;
  const baseOid = base?.oid;
  const active = checkedOut === branchRef && headOid !== undefined && baseOid !== undefined;
  return { project, worktree, headOid, baseOid, baseBranch: base?.branch, active };
}

async function readMergeBase(root: string, headOid: string, baseOid: string) {
  const result = await git(root, ["merge-base", "--all", headOid, baseOid]);
  return result && isGitObjectId(result) ? result : undefined;
}

/** A review only reads committed objects from the admitted worktree. */
export async function verifyFactoryReviewRange(
  worktree: string, headOid: string, baseOid: string,
): Promise<string | undefined> {
  const [head, state, mergeBase] = await Promise.all([
    git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]),
    readWorktreeState(worktree),
    readMergeBase(worktree, headOid, baseOid),
  ]);
  return head === headOid && state === "clean" && mergeBase !== headOid ? mergeBase : undefined;
}

/** Read the selected branch and recorded review subjects from their local authorities. */
export async function readFactoryBranch(
  projectPath: string, repository: string, selection: FactoryBranchSelection & { workItem: FactoryWorkItem }, readReview: ReviewLookup, now: () => number,
): Promise<{ candidate: FactoryBranchProjection; baseBranch?: string }> {
  const { project, worktree, headOid, baseOid, active, baseBranch } = await readFactoryBranchRevision(projectPath, repository, selection);
  const reviewIds = selection.reviewIds ?? [];
  const receipts: FactoryReceiptProjection[] = [];
  if (headOid && reviewIds.length) {
    const identities = new Map<string, Promise<string | undefined>>();
    const identify = (directory: string) => {
      let identity = identities.get(directory);
      if (!identity) identities.set(directory, identity = checkoutIdentity(directory));
      return identity;
    };
    const roots = new Set(await Promise.all([identify(project.path), worktree && identify(worktree.path)]));
    const observed = await Promise.all(reviewIds.map((id) => reviewReceipt(
      readReview(id), async (directory) => {
        const identity = await identify(directory);
        return identity !== undefined && roots.has(identity);
      }, selection.branch,
    )));
    for (const receipt of observed) if (receipt) receipts.push(receipt);
  }
  const { workItem } = selection;
  const result: FactoryBranchProjection = {
    outcomeId: factoryWorkItemKey(workItem), workItem, branch: selection.branch, baseRef: selection.baseRef,
    ...(workItem.provider === "linear" ? { issue: { ...workItem, source: "local_operator" as const } } : {}),
    authority: {
      source: "local_owner_git", runtimeInstanceId: getProcessRuntimeIdentity().instanceId,
      profile: resolveActiveProfileName(), observedAt: now(),
    },
    worktree: worktree?.path, stage: active ? "branch" : "parked", publication: "unobserved", headOid, baseOid, receipts,
  };
  if (selection.assessment && headOid && baseOid && headOid.length === baseOid.length) {
    result.assessment = {
      candidate: { issue: result.outcomeId, repository, branch: selection.branch },
      headSha: headOid, baseSha: baseOid, ...selection.assessment, evidence: [],
    };
  }
  return { candidate: result, baseBranch };
}
