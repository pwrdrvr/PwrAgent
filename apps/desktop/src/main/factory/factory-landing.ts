import { z } from "zod";
import { factoryWorkItemKey } from "@pwragent/shared/factory-work-item";
import {
  buildProjectNeverMergeError, findHandsOffMatch, projectAllowsForgePolling, projectMergesPullRequest, type ProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import { getProjectForgeAutomationIndex } from "../app-server/project-forge-automation-index";
import { assertMergeNotHeld } from "../app-server/thread-dependency-merge-hold";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { createFactoryLandingStorage, createFactoryPublicationStorage } from "../storage/factory-admission-storage";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { createThreadDependencyStorage } from "../storage/desktop-runtime-storage";
import { factoryIntegrationChecks, observeFactoryGithubLanding, type FactoryLandingIdentity } from "./factory-landing-github";
import { createFactoryPublicationEvidence, factoryPlanDigest, readFactoryPublicationPlan } from "./factory-publication";
import { factoryScalingReceiptId } from "./factory-scaling-receipt";

const subject = { approvalId: z.uuid() };
const requiredChecks = z.array(z.string().trim().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)).min(1).max(32)
  .refine((checks) => new Set(checks).size === checks.length, "Select distinct required integration check names.")
  .transform((checks) => checks.sort());
const command = z.discriminatedUnion("action", [
  z.strictObject({ ...subject, action: z.literal("prepare"), requiredChecks }),
  z.strictObject({ ...subject, action: z.literal("enqueue"), requiredChecks, confirm: factoryScalingReceiptId }),
  z.strictObject({ ...subject, action: z.enum(["reconcile", "pause", "resume", "cancel"]) }),
  z.strictObject({ ...subject, action: z.literal("reset"), confirm: factoryScalingReceiptId }),
]);

type Attempt = { planId: string; previousEventId?: string; startedAt: number; acknowledged?: true };
type State = { phase: "ready" | "paused" | "cancelled" } | { phase: "attempted"; attempt: Attempt };
type StoredState = { binding: string; state: State };
type Observation = Awaited<ReturnType<typeof observeFactoryGithubLanding>>;
type Observed = Extract<Observation, { status: "observed" }>;

function stop<const Status extends string>(status: Status, reason: string) {
  return { status, reason };
}

function assertProjectAllowsQueue(
  { label, automation }: { label: string; automation?: ProjectForgeAutomation },
  identity: FactoryLandingIdentity, labels: string[],
) {
  if (!projectAllowsForgePolling(automation)) throw new Error("Resume the project's Forge Automation before preparing a queue action.");
  if (!projectMergesPullRequest(automation, identity.base)) {
    throw new Error(buildProjectNeverMergeError({ projectLabel: label, mergeBranches: automation?.mergeBranches }));
  }
  const [org = "", repo = ""] = identity.repository.split("/");
  const handsOff = findHandsOffMatch(automation, { org, repo, labels });
  if (handsOff) throw new Error(handsOff.label ? `Project Forge Automation leaves PRs labeled "${handsOff.label}" to their maintainers.`
    : "Project Forge Automation leaves this repository's PRs to their maintainers.");
}

function liveRevisionMatches({ pull }: Observed, identity: FactoryLandingIdentity) {
  return pull.headRef?.target.oid === identity.headOid && pull.baseRef?.target.oid === identity.baseOid;
}

function providerOutcome(remote: Observed, identity: FactoryLandingIdentity, attempt?: Attempt) {
  const { pull } = remote;
  // GitHub may advance the target or delete the source branch after it lands.
  // The PR's immutable ID, source ref and head, and destination ref still have to match.
  if (pull.state === "MERGED") return { status: "merged" as const };
  if (pull.state === "CLOSED") return { status: "closed" as const };
  if (pull.mergeQueueEntry) return { status: "queued" as const, queueEntry: pull.mergeQueueEntry, liveBaseOid: pull.baseRef?.target.oid };
  if (pull.isInMergeQueue) return stop("uncertain", "GitHub reports a queue entry but did not return its details. Reconcile again.");
  if (pull.autoMergeRequest) return stop("blocked", "Auto-merge is already enabled in GitHub. Inspect it before preparing a Factory queue action.");
  if (!attempt) return undefined;
  const event = pull.timelineItems.nodes[0];
  if (event?.__typename === "RemovedFromMergeQueueEvent" && event.id !== attempt.previousEventId
    && Date.parse(event.createdAt) >= Math.floor(attempt.startedAt / 1000) * 1000) {
    return { status: "removed" as const, event };
  }
  return stop("uncertain", `GitHub has not confirmed the result for #${identity.number}. Reconcile again after checking the PR in GitHub. This attempt cannot be replayed.`);
}

export function createOwnerFactoryLanding(options: Parameters<typeof createFactoryPublicationEvidence>[0] & {
  github: ForgeCiClient["requestGithub"];
  githubEnabled(): boolean;
  fetcher?: Pick<GithubPrFetcher, "mergePullRequest">;
  now?: () => number;
}) {
  const publication = createFactoryPublicationStorage();
  const store = createFactoryLandingStorage();
  const evidence = createFactoryPublicationEvidence(options);
  const fetcher = options.fetcher ?? new GithubPrFetcher();
  const now = options.now ?? Date.now;
  const inFlight = new Set<string>();

  return async (params: unknown) => {
    const request = command.parse(params);
    const { approvalId, action } = request;
    const saved = publication.read(approvalId);
    if (!saved?.prId || !saved.prNumber) return stop("not_published", "Record the exact published PR with factory-publication reconcile first.");
    if (saved.creationState !== "returned" && saved.creationState !== "none") {
      return stop("blocked", "The publication has no confirmed revision. Reconcile or explicitly re-arm publication before landing.");
    }
    const plan = readFactoryPublicationPlan(saved);
    const { selection } = plan;
    const approval = evidence.resolveApproval(selection);
    const identity: FactoryLandingIdentity = {
      repository: selection.repository, repositoryId: plan.repositoryId, id: saved.prId, number: saved.prNumber,
      branch: selection.branch, base: selection.base, headOid: selection.headOid, baseOid: selection.baseOid,
    };
    const url = `https://github.com/${identity.repository}/pull/${identity.number}`;
    const context = {
      approvalId, workItem: selection.workItem, outcomeId: factoryWorkItemKey(selection.workItem),
      publicationPlanId: saved.planId, pullRequest: { ...identity, url }, mergeAuthority: "operator_only" as const,
    };
    const bindingOf = (published: typeof saved) => JSON.stringify([published.planId, published.prId, published.prNumber]);
    const binding = bindingOf(saved);
    const row = store.read(approvalId);
    const revision = row?.revision ?? 0;
    const stored = row ? JSON.parse(row.stateJson) as StoredState : undefined;
    if (stored && stored.binding !== binding && stored.state.phase !== "ready") {
      return { ...context, ...stop("stale", "The recorded landing state belongs to a different publication.") };
    }
    const state: State = stored?.state ?? { phase: "ready" };
    const attempt = state.phase === "attempted" ? state.attempt : undefined;
    const currentRevision = () => store.read(approvalId)?.revision ?? 0;
    const save = (next: State, atRevision = revision) => {
      if (currentRevision() !== atRevision) return false;
      return store.compareAndSet(saved, atRevision, JSON.stringify({ binding, state: next } satisfies StoredState));
    };
    const raced = () => stop("stale", "The local landing state changed. Read the current state and prepare again.");
    const observe = (signal?: AbortSignal) => {
      if (!options.githubEnabled()) return Promise.resolve(stop("blocked", "GitHub is disabled in this profile."));
      return observeFactoryGithubLanding(options.github, identity, signal);
    };
    const thread = { backend: "codex" as const, threadId: approval.target.threadId };
    const assertPolicy = (labels: string[]) => {
      if (!options.githubEnabled()) throw new Error("GitHub is disabled in this profile.");
      const projects = getProjectForgeAutomationIndex();
      const threadProject = projects.resolveThread(thread);
      const selected = { label: selection.projectKey, automation: projects.get(selection.projectKey) };
      assertProjectAllowsQueue(selected, identity, labels);
      if (threadProject && threadProject.directoryKey !== selection.projectKey) assertProjectAllowsQueue(threadProject, identity, labels);
      assertMergeNotHeld(createThreadDependencyStorage().active(), { ...thread, pullRequest: url },
        (owner) => getDesktopOverlayStore().readThreadPullRequestUrls(owner));
    };

    if (action === "pause" || action === "resume" || action === "cancel") {
      if (attempt) return { ...context, ...stop("attempt_recorded", "The queue request may already have reached GitHub. Reconcile before taking action in GitHub.") };
      const phase = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "ready";
      // Cancel is sticky. A resume only releases a pause.
      if (state.phase === "cancelled" || state.phase === phase) {
        return { ...context, status: state.phase, ...(state.phase === "cancelled" ? { resetId: resetId() } : {}) };
      }
      if (!save({ phase })) return { ...context, ...raced() };
      return { ...context, status: phase, ...(phase === "cancelled" ? { resetId: resetId(revision + 1) } : {}) };
    }

    function resetId(version = revision) {
      return factoryPlanDigest(JSON.stringify([approvalId, saved?.planId, version, "reset"]));
    }

    if (action === "reset" && state.phase === "cancelled") {
      return { ...context, ...(request.confirm === resetId() && save({ phase: "ready" }) ? { status: "ready" } : raced()) };
    }
    if (state.phase === "paused" || state.phase === "cancelled") {
      return { ...context, status: state.phase, ...(state.phase === "cancelled" ? { resetId: resetId() } : {}) };
    }
    if (inFlight.has(approvalId)) return { ...context, status: "in_flight" };

    async function evaluate(checks: string[], signal?: AbortSignal) {
      // At dispatch, put the forge read after slow local Git checks. The merge
      // runner then fences the local receipts and persists the intent synchronously.
      const dispatchEvidence = signal ? await evidence.verify(selection, plan) : undefined;
      if (dispatchEvidence && dispatchEvidence.status !== "current") return { result: dispatchEvidence };
      const remote = await observe(signal);
      if (remote.status !== "observed") return { result: remote };
      const outcome = providerOutcome(remote, identity, attempt);
      if (outcome) return { result: outcome };
      const pull = remote.pull;
      if (!liveRevisionMatches(remote, identity)) {
        return { result: stop("stale", "The live source or target tip differs from the publication plan.") };
      }
      if (pull.isDraft) return { result: stop("blocked", "Mark the published PR ready for review in GitHub.") };
      const labels = pull.labels.nodes.map(({ name }) => name);
      if (selection.notReadyLabel && labels.some((label) => label.toLowerCase() === selection.notReadyLabel?.toLowerCase())) {
        return { result: stop("blocked", `Remove the configured hold label "${selection.notReadyLabel}" when the PR is ready.`) };
      }
      if (pull.labels.pageInfo.hasNextPage) return { result: stop("blocked", "GitHub returned an incomplete label list. Inspect readiness in GitHub.") };
      assertPolicy(labels);
      const local = dispatchEvidence ?? await evidence.verify(selection, plan);
      if (local.status !== "current") return { result: local };
      if (!remote.permission || !["WRITE", "MAINTAIN", "ADMIN"].includes(remote.permission)) {
        return { result: stop("denied", "The selected GitHub account needs write access to this repository.") };
      }
      const ci = factoryIntegrationChecks(pull, identity, checks);
      if (ci.reason) return { result: { ...stop("blocked", ci.reason), ci } };
      if (!pull.isMergeQueueEnabled) {
        return { result: { ...stop("manual_required",
          "This target has no protected GitHub merge queue. Open the PR above, verify the exact head and base, and use its protected merge action."),
          ci, independentReviewId: local.reviewId, scalingReceiptId: local.scalingReceiptId } };
      }
      const preview = {
        ...context, revision, approvalRevision: local.approvalRevision, action: "enqueue", ci, requiredChecks: checks,
        githubAccount: remote.viewer, githubPermission: remote.permission,
        independentReviewId: local.reviewId, scalingReceiptId: local.scalingReceiptId,
        previousEventId: pull.timelineItems.nodes[0]?.id,
      };
      return { preview, local, labels, planId: factoryPlanDigest(JSON.stringify(preview)) };
    }

    if (attempt || action === "reconcile" || action === "reset") {
      const remote = await observe();
      const outcome = remote.status === "observed"
        ? providerOutcome(remote, identity, attempt) ?? (liveRevisionMatches(remote, identity)
          ? { status: "not_attempted" as const }
          : stop("stale", "The live source or target tip differs from the publication plan."))
        : remote;
      if (action === "reset") {
        if (outcome.status !== "removed" || !attempt?.acknowledged || request.confirm !== attempt.planId || !save({ phase: "ready" })) {
          return { ...context, ...stop("blocked", "Reset requires an acknowledged admission and its plan ID, followed by an observed GitHub queue removal.") };
        }
        return { ...context, status: "ready" };
      }
      return { ...context, ...outcome, ...(attempt ? { attemptId: attempt.planId } : {}) };
    }

    if (action !== "prepare" && action !== "enqueue") throw new Error("Invalid Factory landing action.");
    try {
      const current = await evaluate(request.requiredChecks);
      if (current.result) return { ...context, ...current.result };
      if (action === "prepare") {
        return { ...context, status: "prepared", planId: current.planId, preview: current.preview,
          nextStep: "Confirm this plan to request queue admission. GitHub tests the merge group against its live target before landing. The stack policy is rechecked at enqueue." };
      }
      if (request.confirm !== current.planId || currentRevision() !== revision) return { ...context, ...raced() };
      if (inFlight.has(approvalId)) return { ...context, status: "in_flight" };
      inFlight.add(approvalId);
      let dispatched: Attempt | undefined;
      try {
        const result = await fetcher.mergePullRequest({
          pullRequest: url, cwd: current.local.worktree, method: "merge",
          thread,
          deadlineAt: now() + 30_000,
          confirmedQueue: {
            refresh: async (signal) => {
              const fresh = await evaluate(request.requiredChecks, signal);
              if (fresh.result) throw new LandingRefusal(fresh.result);
              if (fresh.planId !== request.confirm) throw new LandingRefusal(raced());
              return {
                gate: { required: true, open: true, checks: "SUCCESS", headSha: identity.headOid,
                  baseRef: identity.base, pullRequestId: identity.id },
                beforeEnqueue: () => {
                  fresh.local.assertCurrent();
                  assertPolicy(fresh.labels);
                  const intent = { planId: fresh.planId, previousEventId: fresh.preview.previousEventId, startedAt: now() };
                  if (!save({ phase: "attempted", attempt: intent })) throw new LandingRefusal(raced());
                  dispatched = intent;
                },
              };
            },
          },
        });
        if (!dispatched || !result.queued) throw new Error("GitHub did not confirm queue admission.");
        if (!save({ phase: "attempted", attempt: { ...dispatched, acknowledged: true } }, revision + 1)) {
          throw new Error("The admitted attempt could not be recorded.");
        }
        return { ...context, status: "queued", attemptId: current.planId, summary: result.summary };
      } catch (error) {
        if (dispatched) return { ...context, attemptId: current.planId,
          ...stop("uncertain", "Queue admission may have reached GitHub. Run reconcile before taking further action.") };
        if (error instanceof LandingRefusal) return { ...context, ...error.result };
        throw error;
      } finally {
        inFlight.delete(approvalId);
      }
    } catch (error) {
      return { ...context, ...stop("blocked", error instanceof Error ? error.message : String(error)) };
    }
  };
}

class LandingRefusal extends Error {
  constructor(readonly result: { status: string; reason?: string }) {
    super(result.reason ?? result.status);
  }
}
