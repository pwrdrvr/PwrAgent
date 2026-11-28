import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { factoryWorkItemKey, parseFactoryWorkItem } from "@pwragent/shared/factory-work-item";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import { FORGE_BODY_MAX_CHARS } from "../pr-status/forge-pr-tool-contract";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { createGithubPullRequest } from "../pr-status/github-pr-tool-client";
import {
  createFactoryAdmissionStorage, createFactoryBranchReviewStorage, createFactoryPublicationStorage,
  type FactoryPublicationRow,
} from "../storage/factory-admission-storage";
import { isFactoryBranchName, isFactoryIntegrationRef, readFactoryCleanCandidate, readFactoryIntegrationTarget } from "./factory-branch-evidence";
import { factoryBranchReviewId } from "./factory-branch-review";
import { approvalWorkItem, localFactoryOwner, registeredFactoryProject, sameFactoryOwner } from "./factory-local-authority";
import { factoryGithubRepository, observeFactoryGithubPublication, readFactoryCreatedPr, type FactoryPublishedPr } from "./factory-publication-github";
import {
  factoryScalingReceiptId, factoryScalingReceiptPath, factoryScalingRevision, factoryScalingStatus,
  matchesFactoryScalingSubject, readFactoryScalingReceipt,
} from "./factory-scaling-receipt";

const approvalId = z.uuid();
const reference = z.string().trim().min(1).max(512).refine((value) => Array.from(value).every((character) => {
  const code = character.charCodeAt(0);
  return code >= 32 && code !== 127;
}));
const number = z.int().min(1).max(2_147_483_647);
const MAX_CREATE_OBSERVATION_AGE_MS = 10_000;
const CREATE_REFUSALS = new Set(["unauthenticated", "forbidden", "not_found", "conflict", "rejected"]);
const createEffect = {
  effect: "open_one_pull_request",
  precondition: "non_atomic_branch_names",
  window: "The pushed head or base can move between the final GitHub observation and creation. GitHub may open the PR against different commits.",
  consequence: "Opening the PR can start CI, even for a draft. The confirmation grants opening one PR only. Merge authority stays with the operator.",
} as const;
const subject = z.strictObject({
  approvalId,
  projectKey: z.string().max(4096).startsWith("directory:"),
  repository: z.string().regex(/^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i).toLowerCase(),
  workItem: z.unknown().optional(),
  issueId: z.unknown().optional(),
  branch: z.string().max(255).refine(isFactoryBranchName),
  baseRef: z.string().max(255).refine(isFactoryIntegrationRef),
  ...factoryScalingRevision.shape,
  pullRequestNumber: number.optional(),
  notReadyLabel: reference.max(100).optional(),
  creation: z.strictObject({ title: reference.max(256), body: z.string().max(FORGE_BODY_MAX_CHARS).optional(), draft: z.boolean() }).optional(),
  previousPlanId: factoryScalingReceiptId.optional(),
  policy: z.strictObject({
    risk: z.strictObject({ level: z.enum(["routine", "high_consequence", "unverified"]), reference }),
    visual: z.strictObject({ decision: z.enum(["accepted", "not_required", "pending"]), reference }),
    acceptOperatorAttestedScaling: z.boolean(),
  }),
});
const command = z.discriminatedUnion("action", [
  subject.extend({ action: z.literal("prepare") }),
  subject.extend({ action: z.literal("arm"), confirm: factoryScalingReceiptId }),
  z.strictObject({ action: z.literal("reconcile"), approvalId }),
]);

function normalize(input: z.infer<typeof subject> & { action: string; confirm?: string }) {
  const { action: _action, confirm: _confirm, issueId, workItem: item, ...rest } = input;
  const workItem = parseFactoryWorkItem({ issueId, workItem: item });
  const tracked = workItem.provider === "github" && workItem.kind === "pull_request" ? workItem : undefined;
  if (tracked && input.pullRequestNumber !== undefined && input.pullRequestNumber !== tracked.number) {
    throw new Error("The tracked work item is a different pull request.");
  }
  if (input.baseRef === `refs/heads/${input.branch}` || input.headOid === input.baseOid) {
    throw new Error("Select distinct candidate and integration branches with different commits.");
  }
  return { ...rest, workItem, pullRequestNumber: tracked ? number.parse(tracked.number) : input.pullRequestNumber };
}

type Selection = ReturnType<typeof normalize>;
export type FactoryPublicationPlan = {
  selection: Selection & { base: string };
  repositoryId: string;
  implementationTurnId: string;
  reviewId: string;
  scalingReceiptId: string;
  initialPr?: { id: string; number: number; readiness: FactoryPublishedPr["readiness"] };
};
type Failure = { status: "blocked" | "stale" | "missing" | "conflict" | "uncertain"; reason: string };

function stopped(status: Failure["status"], reason: string): Failure {
  return { status, reason };
}

export function factoryPlanDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function result(plan: FactoryPublicationPlan, planId: string, pr?: FactoryPublishedPr) {
  return {
    approvalId: plan.selection.approvalId, outcomeId: factoryWorkItemKey(plan.selection.workItem), planId,
    status: pr ? "published" as const : "manual_required" as const, pullRequest: pr,
    mode: mode(plan),
    mergeAuthority: "operator_only" as const,
  };
}

function mode(plan: FactoryPublicationPlan) {
  return plan.initialPr ? "reuse" : plan.selection.creation ? "open_pr" : "manual_open";
}

export function readFactoryPublicationPlan(saved: FactoryPublicationRow): FactoryPublicationPlan {
  if (factoryPlanDigest(saved.planJson) !== saved.planId) throw new Error("The saved Factory publication plan is invalid.");
  return JSON.parse(saved.planJson) as FactoryPublicationPlan;
}

type OwnerOptions = { federation: DesktopFederationRuntime; leaseHeld(): boolean };

export function createFactoryPublicationEvidence(options: OwnerOptions) {
  const admission = createFactoryAdmissionStorage();
  const reviews = createFactoryBranchReviewStorage();
  const owner = () => localFactoryOwner(options.federation, () => options.leaseHeld());

  function resolveApproval(selection: Selection) {
    const row = admission.readByApprovalId(selection.approvalId);
    if (row?.phase !== "terminal" || row.outcome !== "completed" || row.paused || row.cancelRequested || !row.turnId
      || row.projectKey !== selection.projectKey || row.repository !== selection.repository
      || factoryWorkItemKey(approvalWorkItem(row)) !== factoryWorkItemKey(selection.workItem)
      || !sameFactoryOwner(owner(), row.owner) || !sameFactoryOwner(row.owner, row.target)) {
      throw new Error("Factory requires the completed approval, tracked work item and worktree of this local owner.");
    }
    return { ...row, turnId: row.turnId };
  }

  async function verify(selection: Selection, plan?: FactoryPublicationPlan) {
    const { policy, branch, baseRef, headOid, baseOid } = selection;
    const row = resolveApproval(selection);
    const project = await registeredFactoryProject(selection.projectKey);
    if (!project) return stopped("blocked", "The registered local Factory project is unavailable.");
    if (policy.risk.level !== "routine" || policy.visual.decision === "pending" || !policy.acceptOperatorAttestedScaling) {
      return stopped("blocked", "The operator must confirm routine policy, resolve visual acceptance, and explicitly accept the scaling attestation.");
    }
    const worktree = row.target.worktreePath;
    const candidate = await readFactoryCleanCandidate(project, row.repository, selection, worktree);
    if (candidate.state !== "clean" || candidate.headOid !== headOid || candidate.baseOid !== baseOid) {
      return stopped("stale", "The approved local worktree is no longer clean at the selected head and integration tip.");
    }
    if (candidate.baseBranch === branch || (plan && candidate.baseBranch !== plan.selection.base)) {
      return stopped("stale", "The approved integration ref no longer identifies the selected target branch.");
    }
    const reviewId = factoryBranchReviewId(row.id, selection);
    const canonicalWorktree = await realpath(worktree).catch(() => undefined);
    const review = reviews.read(reviewId);
    if (review?.result !== "clear" || review.approvalId !== row.id || !review.turnId || !review.reviewerThreadId
      || review.reviewerThreadId === row.target.threadId || review.turnId === row.turnId || review.worktree !== canonicalWorktree) {
      return stopped("blocked", "A current clear managed branch review receipt is required.");
    }
    const scalingPath = factoryScalingReceiptPath(row.id);
    const scaling = readFactoryScalingReceipt(scalingPath);
    const scalingState = factoryScalingStatus(scaling, candidate, branch, baseRef);
    if (!scaling || !matchesFactoryScalingSubject(scaling, { ...selection, worktree }) || scalingState !== "current") {
      return stopped(scalingState === "stale" ? "stale" : "blocked", `A current passing scaling receipt is required (${scalingState}).`);
    }
    if (plan && (plan.reviewId !== reviewId || plan.scalingReceiptId !== scaling.receiptId || plan.implementationTurnId !== row.turnId)) {
      return stopped("stale", "The approval evidence changed after the publication plan was armed.");
    }
    assertApprovalCurrent();
    function assertApprovalCurrent() {
      if (resolveApproval(selection).revision !== row.revision) throw new Error("The Factory approval changed during preflight.");
    }
    const assertCurrent = () => {
      assertApprovalCurrent();
      const latest = reviews.read(reviewId);
      if (latest?.result !== "clear" || latest.turnId !== review.turnId || latest.reviewerThreadId !== review.reviewerThreadId
        || readFactoryScalingReceipt(scalingPath)?.receiptId !== scaling.receiptId) {
        throw new Error("The Factory review or scaling receipt changed during preflight.");
      }
    };
    return { status: "current" as const, worktree, assertCurrent, base: candidate.baseBranch,
      approvalRevision: row.revision, implementationTurnId: row.turnId, reviewId, scalingReceiptId: scaling.receiptId };
  }

  return { resolveApproval, verify };
}

export function createOwnerFactoryPublication(options: {
  federation: DesktopFederationRuntime; leaseHeld(): boolean; github: ForgeCiClient["requestGithub"];
  prepareCreatePolicy(threadId: string, repository: ForgeRepository): Promise<() => void>;
}) {
  const { resolveApproval, verify } = createFactoryPublicationEvidence(options);
  const store = createFactoryPublicationStorage();
  const creating = new Set<string>();

  function readRemote(selection: FactoryPublicationPlan["selection"], repositoryId?: string, saved?: FactoryPublicationRow) {
    const tracked = selection.workItem.provider === "github" && selection.workItem.kind === "pull_request"
      ? selection.workItem : undefined;
    return observeFactoryGithubPublication(options.github, {
      ...selection, repositoryId: repositoryId ?? tracked?.repositoryId,
      prNumber: saved?.prNumber ?? selection.pullRequestNumber, prId: saved?.prId ?? undefined,
    });
  }

  async function reconcile(saved: FactoryPublicationRow) {
    const plan = readFactoryPublicationPlan(saved);
    const row = resolveApproval(plan.selection);
    const identity = { approvalId: saved.approvalId, planId: saved.planId, recordedPrNumber: saved.prNumber };
    const unresolved = (reason: string) => ({ ...identity, ...stopped("uncertain", reason) });
    if (creating.has(saved.approvalId)) return unresolved("The claimed PR creation is still in progress. Reconcile after it finishes.");
    const remote = await readRemote(plan.selection, plan.repositoryId, saved);
    const pending = saved.creationState === "pending";
    const pr = remote.status === "current" ? remote.pr : undefined;
    // Resolve a possible write even when the old local revision is stale. A
    // mismatched PR is pinned for a new review and can never satisfy this plan.
    if (pending && (pr || (remote.status !== "current" && remote.prIdentity))) {
      if (resolveApproval(plan.selection).revision !== row.revision) return unresolved("The Factory approval changed during reconciliation.");
      const witnessed = pr ?? (remote.status !== "current" ? remote.prIdentity : undefined);
      store.settle(saved, pr ? "returned" : "fenced", witnessed);
    }
    const local = await verify(plan.selection, plan);
    const current = store.read(saved.approvalId);
    if (current?.planId !== saved.planId) return { ...identity, ...stopped("conflict", "A newer publication plan owns this approval.") };
    if (current.creationState === "pending") {
      return unresolved("GitHub has not resolved the possible PR creation. Reconcile again before re-arming.");
    }
    if (local.status !== "current") return { ...identity, ...local };
    if (remote.status !== "current") return { ...identity, ...remote };
    if (current.creationState === "fenced") {
      return { ...identity, ...stopped("stale", "The PR creation differed from this approval. Review its current revision and prepare a replacement plan for the same PR.") };
    }
    if (!pr) return current.creationState === "refused"
      ? { ...identity, ...stopped("blocked", "GitHub refused creation. Prepare and confirm a replacement plan to try again.") }
      : { ...identity, ...stopped("missing", "No pull request is visible for the armed revision.") };
    if ((current.prId !== null || !store.settle(current, "none", pr)) && store.read(saved.approvalId)?.prId !== pr.id) {
      return { ...identity, ...stopped("conflict", "A different pull request or approval already owns this publication.") };
    }
    return result(plan, saved.planId, pr);
  }

  async function create(plan: FactoryPublicationPlan, record: FactoryPublicationRow, previous: FactoryPublicationRow | undefined,
    row: ReturnType<typeof resolveApproval>, observedAt: number, checkPolicy: () => void, assertEvidence: () => void) {
    const { selection } = plan;
    const creation = selection.creation!;
    let claimed = false;
    let denial: Failure | undefined;
    let payload: unknown;
    try {
      payload = await createGithubPullRequest(options.github, factoryGithubRepository(selection.repository),
        { ...creation, head: selection.branch, base: selection.base }, {
          beforeDispatch: () => {
            try {
              checkPolicy();
              assertEvidence();
              if (resolveApproval(selection).revision !== row.revision || performance.now() - observedAt > MAX_CREATE_OBSERVATION_AGE_MS) {
                denial = stopped("stale", "The publication observation or local approval evidence expired before GitHub could open the PR.");
              }
            } catch (error) {
              denial = stopped("blocked", error instanceof Error ? error.message : "The publication policy or owner changed.");
            }
            if (!denial && !store.arm(record, previous)) denial = stopped("conflict", "Another publication claim owns this approval or branch.");
            if (denial) throw new ForgeReadError("cancelled", denial.reason);
            creating.add(record.approvalId);
            claimed = true;
          },
        });
    } catch (error) {
      if (denial) return denial;
      if (!claimed) return stopped("blocked", "GitHub could not start the approved PR request. Check provider access and availability.");
      if (error instanceof ForgeReadError && CREATE_REFUSALS.has(error.code)) {
        store.settle(record, "refused");
        return { planId: record.planId, ...stopped("blocked", `GitHub refused the PR request. ${error.message}`) };
      }
      return { planId: record.planId, ...stopped("uncertain", "GitHub may have opened the PR. Reconcile this approval before taking further action.") };
    } finally {
      if (claimed) creating.delete(record.approvalId);
    }
    if (!claimed) return stopped("blocked", "The forge transport did not admit the PR request.");
    const receipt = readFactoryCreatedPr(payload, { ...selection, repositoryId: plan.repositoryId, draft: creation.draft });
    if (!receipt || !store.settle(record, receipt.matches ? "returned" : "fenced", receipt)) {
      return { planId: record.planId, ...stopped("uncertain", "GitHub did not confirm the PR creation identity. Reconcile this approval.") };
    }
    return reconcile(store.read(record.approvalId)!);
  }

  return async (params: unknown) => {
    const request = command.parse(params);
    const saved = store.read(request.approvalId);
    if (request.action === "reconcile") {
      return saved ? reconcile(saved) : { status: "not_armed", approvalId: request.approvalId };
    }
    const { action } = request;
    const confirm = request.action === "arm" ? request.confirm : undefined;
    const selection = normalize(request);
    const row = resolveApproval(selection);
    let previous: FactoryPublicationPlan | undefined;
    if (saved) {
      previous = readFactoryPublicationPlan(saved);
      const { base: _resolvedBase, ...previousRequest } = previous.selection;
      if (action === "arm" && confirm === saved.planId && JSON.stringify(selection) === JSON.stringify(previousRequest)) return reconcile(saved);
      if (selection.previousPlanId !== saved.planId) return { status: "already_armed", approvalId: saved.approvalId, planId: saved.planId };
      if (saved.creationState === "pending") return stopped("uncertain", "Reconcile the possible PR creation before preparing a replacement plan.");
      if (previous.selection.branch !== selection.branch
        || (saved.prNumber !== null && selection.pullRequestNumber !== undefined && saved.prNumber !== selection.pullRequestNumber)) {
        return stopped("conflict", "A replacement must keep the armed branch, target and any recorded pull request.");
      }
    } else if (selection.previousPlanId) {
      return stopped("stale", "The plan selected for replacement is no longer armed.");
    }
    const project = await registeredFactoryProject(selection.projectKey);
    const target = project && await readFactoryIntegrationTarget(project, selection.baseRef, `github.com/${selection.repository}`);
    if (!target || target.oid !== selection.baseOid || target.branch === selection.branch) {
      return stopped("stale", "The approved target ref or its revision changed.");
    }
    if (previous && previous.selection.base !== target.branch) {
      return stopped("conflict", "A replacement must keep the armed target branch.");
    }
    const resolved = { ...selection, base: target.branch };
    const observedAt = performance.now();
    const remote = await readRemote(resolved, previous?.repositoryId, saved);
    const local = await verify(selection);
    if (local.status !== "current") return local;
    if (target.branch !== local.base) return stopped("stale", "The target ref changed during publication preflight.");
    if (remote.status !== "current") return remote;
    const { pr, repositoryId } = remote;
    const { implementationTurnId, reviewId, scalingReceiptId } = local;
    const plan: FactoryPublicationPlan = {
      selection: resolved, repositoryId, implementationTurnId, reviewId, scalingReceiptId,
      initialPr: pr && { id: pr.id, number: pr.number, readiness: pr.readiness },
    };
    const planJson = JSON.stringify(plan);
    const planId = factoryPlanDigest(planJson);
    const opensPr = mode(plan) === "open_pr";
    let checkPolicy: (() => void) | undefined;
    if (opensPr) {
      try {
        checkPolicy = await options.prepareCreatePolicy(row.target.threadId, factoryGithubRepository(selection.repository));
        checkPolicy();
      } catch (error) {
        return stopped("blocked", error instanceof Error ? error.message : "The forge policy could not be read.");
      }
    }
    if (action === "prepare") return {
      status: "prepared", planId, plan, pullRequest: pr, mode: mode(plan),
      creation: opensPr ? createEffect : "operator_only_github_has_no_revision_precondition",
    };
    if (confirm !== planId) return stopped("stale", "Publication evidence changed. Prepare again and confirm the new plan.");
    const record: FactoryPublicationRow = {
      approvalId: selection.approvalId, planId, planJson, prId: pr?.id ?? null, prNumber: pr?.number ?? null,
      creationState: opensPr ? "pending" : pr && (saved?.creationState === "returned" || saved?.creationState === "fenced") ? "returned" : "none",
    };
    if (checkPolicy) return create(plan, record, saved, row, observedAt, checkPolicy, local.assertCurrent);
    if (!store.arm(record, saved)) {
      const concurrent = store.read(selection.approvalId);
      if (concurrent?.planId !== planId) return stopped("conflict", "A different plan or approval already owns this publication.");
      return reconcile(concurrent);
    }
    return result(plan, planId, pr);
  };
}
