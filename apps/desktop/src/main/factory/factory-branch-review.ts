import { createHash } from "node:crypto";
import { factoryAdmissionSubject, type FactoryAdmissionRow, type FactoryAdmissionSubject, type FactoryOwner } from "@pwragent/owner-core/factory-admission";
import type { AppServerThreadReviewEntry, PinnedBranchReviewVerdict } from "@pwragent/shared/contracts/normalized-app-server";
import { buildThreadUrl, isThreadLinkId } from "@pwragent/shared/contracts/thread-link";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import type { PinnedManagedBranchReview } from "../app-server/backend-registry-types";
import type { createFactoryBranchReviewStorage } from "../storage/factory-admission-storage";
import { readFactoryBranchRevision, verifyFactoryReviewRange } from "./factory-branch-evidence";
import { readFactoryBranchSelection } from "./factory-evidence-collector";

export interface FactoryBranchReviewPorts {
  admission(subject: FactoryAdmissionSubject): FactoryAdmissionRow | undefined;
  owner(): FactoryOwner | undefined;
  project(projectKey: string): Promise<string | undefined>;
  originMatches(directory: string, repository: string): Promise<boolean>;
  threadReady(row: FactoryAdmissionRow): Promise<boolean>;
  start(threadId: string, review: PinnedManagedBranchReview): Promise<unknown>;
  readResult(threadId: string, turnId: string): Promise<AppServerThreadReviewEntry | undefined>;
  store: Pick<ReturnType<typeof createFactoryBranchReviewStorage>, "read" | "claim" | "observe">;
  runtimeId: string;
}

function readCommand(input: Record<string, unknown>) {
  const { action, projectKey, headOid, baseOid } = input;
  if ((action !== "start" && action !== "status") || typeof projectKey !== "string"
    || !projectKey.startsWith("directory:") || projectKey.length > 4096
    || typeof headOid !== "string" || !isGitObjectId(headOid)
    || typeof baseOid !== "string" || !isGitObjectId(baseOid) || headOid.length !== baseOid.length
    || Object.keys(input).some((key) => !["action", "projectKey", "workItem", "issueId", "branch", "baseRef", "baseOid", "headOid"].includes(key))) {
    throw new Error("Specify start or status, the approved project and tracking record, branch, target ref, and full head and base object IDs.");
  }
  const selection = readFactoryBranchSelection({
    workItem: input.workItem, issueId: input.issueId, branch: input.branch, baseRef: input.baseRef,
  });
  if (!selection) throw new Error("Select a Factory branch.");
  return { ...selection, projectKey, action, headOid, baseOid };
}

function sameOwner(owner: FactoryOwner | undefined, expected: FactoryOwner) {
  return owner?.instanceId === expected.instanceId && owner.machineId === expected.machineId;
}

function isReviewVerdict(value: unknown): value is PinnedBranchReviewVerdict {
  return value === "clear" || value === "findings" || value === "inconclusive";
}

export function factoryBranchReviewId(approvalId: string, candidate: {
  branch: string; baseRef: string; headOid: string; baseOid: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    approvalId, candidate.branch, candidate.baseRef, candidate.headOid, candidate.baseOid,
  ])).digest("hex");
}

export class FactoryBranchReview {
  constructor(private readonly ports: FactoryBranchReviewPorts) {}

  /** This command runs only in the local operator's owner transport. */
  async command(params: Record<string, unknown>) {
    const { ports } = this;
    const { action, projectKey, ...candidate } = readCommand(params);
    const subject = factoryAdmissionSubject(projectKey, candidate.workItem);
    const approval = ports.admission(subject);
    if (approval?.phase !== "terminal" || approval.outcome !== "completed" || !approval.turnId
      || !sameOwner(ports.owner(), approval.owner) || !sameOwner(approval.owner, approval.target)
      || !isThreadLinkId(approval.target.threadId)) {
      throw new Error("Branch review requires a completed Factory implementation on this owner and its approved local worktree.");
    }
    const project = await ports.project(projectKey);
    if (!project) throw new Error("The registered local Factory project is unavailable.");
    const id = factoryBranchReviewId(approval.id, candidate);
    const selection = { ...candidate, worktree: approval.target.worktreePath };
    const readRevision = () => readFactoryBranchRevision(project, `github.com/${approval.repository}`, selection);
    const readOrigins = async (worktree?: string) =>
      (await ports.originMatches(project, approval.repository))
      && (!worktree || await ports.originMatches(worktree, approval.repository));
    const revision = await readRevision();
    const worktree = revision.worktree?.path;
    if (!await readOrigins(worktree)) throw new Error("The Factory origin does not match the registered approval.");
    const matches = revision.headOid === candidate.headOid && revision.baseOid === candidate.baseOid;
    const previous = ports.store.read(id);
    const visible = (current: typeof revision | undefined, row: typeof previous) => {
      const currentWorktree = current?.worktree?.path;
      const currentRange = current?.headOid === candidate.headOid && current.baseOid === candidate.baseOid;
      const turnId = row?.turnId;
      const sourceKey = turnId ? `managed-review:${turnId}:result` : undefined;
      return {
        id, approvalId: approval.id, implementationTurnId: approval.turnId,
        ...subject, repository: approval.repository, target: approval.target,
        branch: candidate.branch, baseRef: candidate.baseRef, headOid: candidate.headOid, baseOid: candidate.baseOid,
        observedHeadOid: current?.headOid, observedBaseOid: current?.baseOid, mergeBaseOid: row?.mergeBaseOid,
        stage: current?.active ? "branch" : current?.headOid ? "parked" : "unverified",
        publication: "unobserved",
        acceptance: { humanVisual: "unverified", scaling: "unverified" },
        status: !currentRange || (row && currentWorktree && row.worktree !== currentWorktree) ? "stale"
          : row?.result ?? (row ? row.runtimeId === ports.runtimeId && turnId ? "started" : "uncertain" : "unrequested"),
        recordedResult: row?.result ?? undefined,
        reviewerThreadId: row?.reviewerThreadId ?? undefined, turnId: turnId ?? undefined,
        reference: sourceKey && isThreadLinkId(sourceKey) && (row?.result === "clear"
          || row?.result === "findings" || row?.result === "inconclusive")
          ? buildThreadUrl({ backend: "codex", threadId: approval.target.threadId, messageId: sourceKey }) : undefined,
      };
    };
    if (action === "status" || previous) {
      if (previous?.turnId && previous.reviewerThreadId && !previous.result && previous.runtimeId !== ports.runtimeId) {
        const artifact = await ports.readResult(approval.target.threadId, previous.turnId);
        const recovered = artifact?.pinnedBranchReview;
        if (artifact?.turn?.status === "completed" && artifact.turn.id === previous.turnId
          && recovered?.attemptId === id && artifact.context?.headCommit === candidate.headOid
          && artifact.context.baseCommit === previous.mergeBaseOid && isReviewVerdict(recovered.verdict)) {
          if (!sameOwner(ports.owner(), approval.owner)) throw new Error("The Factory owner is no longer active.");
          ports.store.observe(id, previous.reviewerThreadId, previous.turnId, recovered.verdict);
          return visible(revision, ports.store.read(id));
        }
      }
      return visible(revision, previous);
    }
    if (!matches || !revision.active || !worktree || worktree === revision.project.path
      || approval.paused || approval.cancelRequested || !await ports.threadReady(approval)) {
      throw new Error("Select the exact committed range in the approved active worktree of the idle implementation thread.");
    }
    const mergeBase = await verifyFactoryReviewRange(worktree, candidate.headOid, candidate.baseOid);
    if (!mergeBase) throw new Error("Review requires a clean committed worktree and a unique merge base with changes to review.");
    if (!sameOwner(ports.owner(), approval.owner)) throw new Error("The Factory owner is no longer active.");
    if (!ports.store.claim({ id, approvalId: approval.id, worktree, mergeBaseOid: mergeBase, runtimeId: ports.runtimeId })) {
      const attempt = ports.store.read(id);
      if (attempt) return visible(revision, attempt);
      throw new Error("This approval or worktree already has a running or uncertain branch review.");
    }
    let readyToDispatch = false;
    try {
      await ports.start(approval.target.threadId, {
        id,
        context: { workspacePath: worktree, repositoryPath: revision.project.path,
          gitBranch: candidate.branch, baseBranch: candidate.baseRef, baseCommit: mergeBase, headCommit: candidate.headOid },
        beforeTurn: async () => {
          const latest = await readRevision().catch(() => undefined);
          if (!sameOwner(ports.owner(), approval.owner) || !latest?.active || latest.worktree?.path !== worktree
            || latest.project.common !== revision.project.common
            || latest.headOid !== candidate.headOid || latest.baseOid !== candidate.baseOid || !await readOrigins(worktree)
            || await verifyFactoryReviewRange(worktree, candidate.headOid, candidate.baseOid) !== mergeBase) {
            throw new Error("The Factory candidate moved before the review could start.");
          }
          readyToDispatch = true;
        },
        observe: (reviewer, turnId, result) => ports.store.observe(id, reviewer, turnId, result ?? null),
      });
    } catch {
      // Once the final check has passed, the turn may have reached the provider.
      if (!readyToDispatch) ports.store.observe(id, null, null, "refused");
    }
    return visible(await readRevision().catch(() => undefined), ports.store.read(id));
  }
}
