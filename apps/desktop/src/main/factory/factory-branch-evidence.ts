import { realpath } from "node:fs/promises";
import type { ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import { buildThreadUrl, isThreadLinkId } from "@pwragent/shared/contracts/thread-link";
import { canonicalizeNavigationPath } from "@pwragent/shared/directory-navigation";
import type { FactoryBranchProjection, FactoryBranchSelection, FactoryReceiptProjection } from "@pwragent/shared/factory-projection";
import { factoryWorkItemKey, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import { runGitCommand } from "../app-server/git-executable";
import { getProcessRuntimeIdentity, resolveActiveProfileName } from "../profile";
import { parseGitHubRemote } from "../pr-status/git-remote";

type ReviewLookup = (id: string) => ThreadReview | undefined;

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  return (await runGitCommand(cwd, args, {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" }, timeout: 3_000, maxBuffer: 32_768,
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

async function refOid(root: string, ref: string): Promise<string | undefined> {
  const value = await git(root, ["for-each-ref", "--count=1", "--format=%(refname) %(objecttype) %(objectname)", "--", ref]);
  const [name, type, oid] = value?.split(" ") ?? [];
  return name === ref && type === "commit" && oid && isGitObjectId(oid) ? oid : undefined;
}

async function baseRefOid(root: string, ref: string, repository: string): Promise<string | undefined> {
  const tracking = /^refs\/remotes\/([^/]+)\//.exec(ref)?.[1];
  if (tracking) {
    const url = await git(root, ["remote", "get-url", "--", tracking]);
    const remote = url ? parseGitHubRemote(url) : undefined;
    if (!remote || `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase() !== repository.toLowerCase()) return undefined;
  }
  return refOid(root, ref);
}

function reviewReceipt(
  review: ThreadReview | undefined, roots: Set<string>, branch: string, headOid?: string, mergeBaseOid?: string,
): FactoryReceiptProjection | undefined {
  const context = review?.context;
  if (review?.origin !== "automatic" || !context || !headOid
    || !isThreadLinkId(review.threadId) || context.gitBranch !== branch || context.reviewedTree
    || context.pullRequest || context.pullRequests?.length) return;
  if (!roots.has(canonicalizeNavigationPath(context.workspacePath))
    && (!context.repositoryPath || !roots.has(canonicalizeNavigationPath(context.repositoryPath)))) return;
  const head = context.headCommit;
  const base = context.baseCommit;
  if (!head || !isGitObjectId(head)) return;
  const reference = buildThreadUrl({
    threadId: review.threadId, backend: review.backend,
    messageId: isThreadLinkId(review.sourceKey) ? review.sourceKey : undefined,
  });
  return {
    kind: "review", source: "owner_review", name: review.id, reference, headOid: head,
    mergeBaseOid: base && isGitObjectId(base) ? base : undefined,
    status: head !== headOid ? "stale_head" : base && mergeBaseOid && base !== mergeBaseOid ? "stale_base"
      : !mergeBaseOid || base !== mergeBaseOid ? "inconclusive"
        : review.status === "open" || review.items.some((item) => item.status === "open") ? "pending" : "inconclusive",
  };
}

/** Read the selected branch and recorded review subjects from their local authorities. */
export async function readFactoryBranch(
  projectPath: string, repository: string, selection: FactoryBranchSelection & { workItem: FactoryWorkItem }, readReview: ReviewLookup, now: () => number,
): Promise<FactoryBranchProjection> {
  const project = await checkout(projectPath);
  if (!project) throw new Error("The registered Factory project checkout could not be verified.");
  const worktree = selection.worktree ? await checkout(selection.worktree) : undefined;
  if (worktree && worktree.common !== project.common) throw new Error("The Factory worktree belongs to a different project.");
  const branchRef = `refs/heads/${selection.branch}`;
  const [headOid, baseOid, checkedOut] = await Promise.all([
    refOid(project.path, branchRef),
    baseRefOid(project.path, selection.baseRef, repository),
    worktree ? git(worktree.path, ["symbolic-ref", "--quiet", "HEAD"]) : undefined,
  ]);
  const active = checkedOut === branchRef && headOid !== undefined && baseOid !== undefined;
  const roots = new Set([project.path, projectPath].map(canonicalizeNavigationPath));
  if (worktree && selection.worktree) {
    roots.add(canonicalizeNavigationPath(worktree.path));
    roots.add(canonicalizeNavigationPath(selection.worktree));
  }
  const reviewIds = selection.reviewIds ?? [];
  const commonAncestor = reviewIds.length && headOid && baseOid
    ? await git(project.path, ["merge-base", "--all", headOid, baseOid]) : undefined;
  const mergeBaseOid = commonAncestor && isGitObjectId(commonAncestor) ? commonAncestor : undefined;
  const receipts = reviewIds.map((id) => reviewReceipt(
    readReview(id), roots, selection.branch, headOid, mergeBaseOid,
  )).filter((receipt): receipt is FactoryReceiptProjection => receipt !== undefined);
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
  if (!selection.assessment || !headOid || !baseOid || headOid.length !== baseOid.length) return result;
  return {
    ...result,
    assessment: {
      candidate: { issue: result.outcomeId, repository, branch: selection.branch },
      headSha: headOid, baseSha: baseOid, ...selection.assessment,
      evidence: receipts.flatMap((receipt) => mergeBaseOid && receipt.headOid === headOid && receipt.mergeBaseOid === mergeBaseOid && receipt.reference
        ? [{
          kind: "review" as const, headSha: headOid, reference: receipt.reference,
          observation: receipt.status === "pending"
            ? "The owner review record for this revision is open."
            : "The owner recorded a review of this revision. Independent correctness is unverified.",
        }] : []),
    },
  };
}
