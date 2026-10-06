import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind, AppServerThreadMessageOrigin, AppServerThreadTurnMetadata,
  ManageThreadDependenciesRequest, ManageThreadDependenciesResponse, PrSummary,
  ThreadDependency, ThreadDependencyCondition, ThreadDependencyEvidence,
} from "@pwragent/shared";
import { isRepairableDependencyFailure, THREAD_DEPENDENCY_CONDITIONS } from "@pwragent/shared";
import type { ThreadDependencyStore } from "../state/thread-dependency-store";

export type DependencyThreadSnapshot = {
  activeTurnId?: string;
  turns: AppServerThreadTurnMetadata[];
  prs: { pr: PrSummary; fetchedAt: number }[];
};

type Options = {
  store: ThreadDependencyStore;
  readThread(condition: Pick<ThreadDependencyCondition, "backend" | "threadId"> & Partial<ThreadDependencyCondition>): Promise<DependencyThreadSnapshot>;
  submit(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: { type: "text"; text: string }[];
    origin: "automation";
    messageOrigin: AppServerThreadMessageOrigin;
  }): Promise<{ status: "started" | "busy"; turnId?: string }>;
  changed(dependency: ThreadDependency): Promise<void>;
  canDispatch?: (dependency: ThreadDependency) => boolean;
  isConsumerBusy?: (dependency: ThreadDependency) => boolean;
  hasDeliveryReceipt?: (dependency: ThreadDependency) => boolean;
  now?: () => number;
};

const CURRENT_STATUS_MAX_AGE_MS = 60_000;
const identity = (value: { backend: string; threadId: string }): string => JSON.stringify([value.backend, value.threadId]);

export class ThreadDependencyCoordinator {
  private work = Promise.resolve();
  private readonly busyConsumers = new Set<string>();

  constructor(private readonly options: Options) {}

  /** All local events serialize; SQLite compare-and-swap owns cross-process admission. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.work.then(fn);
    this.work = result.then(() => undefined, () => undefined);
    return result;
  }

  manage(request: ManageThreadDependenciesRequest & { backend: AppServerBackendKind; threadId: string }): Promise<ManageThreadDependenciesResponse> {
    return this.serialize(async () => {
      if (request.action === "list") return this.response(request);
      if (request.action === "cancel" || request.action === "dismiss") {
        if (!request.dependencyId) throw new Error("dependencyId is required to cancel a dependency.");
        const changed = request.action === "dismiss"
          ? this.options.store.dismiss(request.backend, request.threadId, request.dependencyId, this.now())
          : this.options.store.cancel(request.backend, request.threadId, request.dependencyId, this.now());
        const response = this.response(request);
        await this.options.changed(changed);
        return response;
      }
      validateDependencyCreate(request);
      // Validate the consumer too: a mistyped id must never become a durable wake target.
      await this.options.readThread(request);
      const conditions: ThreadDependencyCondition[] = [];
      for (const original of request.conditions!) {
        const condition = { ...original };
        const snapshot = await this.options.readThread(condition);
        if (condition.when === "turn_completed" && !condition.turnId) {
          condition.turnId = snapshot.activeTurnId ?? snapshot.turns.at(-1)?.id;
          if (!condition.turnId) throw new Error("There is no turn to watch. Start the prerequisite turn or supply turnId.");
        }
        if (condition.when === "turn_completed" && condition.turnId !== snapshot.activeTurnId
          && !snapshot.turns.some((turn) => turn.id === condition.turnId)) throw new Error("The watched turn was not found in this prerequisite thread.");
        conditions.push(condition);
      }
      const now = this.now();
      const item = this.options.store.register({
        id: randomUUID(), backend: request.backend, threadId: request.threadId,
        conditions, mode: request.mode ?? "all", onFailure: request.onFailure ?? "notify",
        ...(request.continuation?.trim() ? { continuation: request.continuation.trim() } : {}),
        status: "waiting", evidence: [], createdAt: now, updatedAt: now,
      });
      await this.evaluate(item);
      await this.options.changed(item);
      return this.response(request);
    });
  }

  private response(target: { backend: AppServerBackendKind; threadId: string }): ManageThreadDependenciesResponse {
    return {
      dependencies: this.options.store.list(target.backend, target.threadId),
      dependents: this.options.store.dependents(target.backend, target.threadId),
    };
  }

  reconcile(): Promise<void> {
    return this.serialize(async () => {
      for (const item of this.options.store.active()) {
        if (item.status === "dispatching") {
          if (this.options.hasDeliveryReceipt?.(item)) {
            await this.save(item, { ...item, status: "delivered", error: undefined });
            continue;
          }
          if (item.dispatchOwnerPid && processIsAlive(item.dispatchOwnerPid)) continue;
          // A backend turn/start has no idempotency key. Never replay an
          // uncertain admission after a crash and create a duplicate turn.
          if (!item.error) await this.save(item, { ...item, error: "Continuation delivery was interrupted. Inspect this thread before scheduling another dependency." });
        } else await this.evaluate(item);
      }
    });
  }

  handleThreadEvent(target: { backend: AppServerBackendKind; threadId: string }, turn?: AppServerThreadTurnMetadata, consumerAvailable = false): Promise<void> {
    return this.serialize(async () => {
      if (turn || consumerAvailable) this.busyConsumers.delete(identity(target));
      for (const item of this.options.store.active()) {
        if (identity(item) === identity(target) || item.conditions.some((condition) => identity(condition) === identity(target))) {
          await this.evaluate(item, turn ? { target, turn } : undefined);
        }
      }
    });
  }

  /** One pass for every PR observed together; omit urls to recheck all PR prerequisites. */
  handlePrEvent(prUrls?: string | readonly string[]): Promise<void> {
    const urls = prUrls === undefined ? undefined : new Set(typeof prUrls === "string" ? [prUrls] : prUrls);
    if (urls?.size === 0) return Promise.resolve();
    return this.serialize(async () => {
      for (const item of this.options.store.active()) {
        if (item.conditions.some((condition) => condition.when !== "turn_completed")
          && (!urls || item.conditions.some((condition) => condition.prUrl !== undefined && urls.has(condition.prUrl))
            || item.evidence.some((entry) => entry.prUrl !== undefined && urls.has(entry.prUrl)))) await this.evaluate(item);
      }
    });
  }

  private async evaluate(item: ThreadDependency, signal?: { target: { backend: string; threadId: string }; turn: AppServerThreadTurnMetadata }): Promise<void> {
    if (item.status === "dispatching") return;
    const evidence: ThreadDependencyEvidence[] = [];
    const snapshots = new Map<string, DependencyThreadSnapshot>();
    for (const condition of item.conditions) {
      const previous = item.evidence.find((entry) => JSON.stringify(entry.condition) === JSON.stringify(condition));
      // A pinned turn is immutable after completion. CI evidence is deliberately
      // reevaluated, including when the consumer was busy at the last success.
      if (condition.when === "turn_completed" && previous && previous.state !== "waiting") {
        evidence.push(previous);
        continue;
      }
      if (signal && condition.when === "turn_completed" && identity(signal.target) === identity(condition) && signal.turn.id === condition.turnId) {
        evidence.push(evaluateCondition(condition, { turns: [signal.turn], prs: [] }, this.now(), signal.turn));
        continue;
      }
      try {
        const snapshotKey = JSON.stringify([identity(condition), condition.when === "turn_completed" ? condition.turnId : "pr"]);
        let snapshot = snapshots.get(snapshotKey);
        if (!snapshot) {
          snapshot = await this.options.readThread(condition);
          snapshots.set(snapshotKey, snapshot);
        }
        const turn = signal && identity(signal.target) === identity(condition) && signal.turn.id === condition.turnId
          ? signal.turn : snapshot.turns.find((entry) => entry.id === condition.turnId);
        // Keep the first unambiguous PR identity even if another PR is attached
        // later. Its current head remains live unless explicitly pinned.
        const selector = !condition.prUrl && previous?.prUrl
          ? { ...condition, prUrl: previous.prUrl } : condition;
        const observed = { ...evaluateCondition(selector, snapshot, this.now(), turn), condition };
        if (!observed.prUrl && previous?.prUrl) {
          observed.prUrl = previous.prUrl;
          observed.headSha = previous.headSha;
        }
        evidence.push(observed);
      } catch (error) {
        evidence.push({
          condition, state: "waiting", reason: `Prerequisite unavailable: ${error instanceof Error ? error.message : String(error)}`, observedAt: this.now(),
          ...(previous?.prUrl ? { prUrl: previous.prUrl, headSha: previous.headSha } : {}),
        });
      }
    }
    const successes = evidence.filter((entry) => entry.state === "satisfied").length;
    const failures = evidence.filter((entry) => entry.state === "failed").length;
    const success = item.mode === "all" ? successes === evidence.length : successes > 0;
    const failure = item.mode === "all" ? failures > 0 : failures === evidence.length;
    const staleOnly = !success && !failure && evidence.every((entry) => entry.state === "satisfied"
      || entry.reason === "Waiting for fresh CI status for the current head");
    const persistedEvidence = evidence.map((entry, index) => {
      const previous = item.evidence[index];
      // Age gates admission in memory. It must not toggle durable readiness on
      // unrelated events and then write it back on every unchanged PR refresh.
      return entry.reason === "Waiting for fresh CI status for the current head"
        && previous?.state === "satisfied" && previous.prUrl === entry.prUrl && previous.headSha === entry.headSha
        ? previous : entry;
    });
    const next: ThreadDependency = {
      ...item, evidence: persistedEvidence,
      status: success || failure || (staleOnly && item.status === "ready") ? "ready" : "waiting",
      outcome: success ? "success" : failure ? "failure" : staleOnly && item.status === "ready" ? item.outcome : undefined,
      error: undefined,
    };
    const current = await this.save(item, next);
    if (!success && !failure) return;
    if (!current || current.status !== "ready" || this.options.canDispatch?.(current) === false
      || this.options.isConsumerBusy?.(current) || this.busyConsumers.has(identity(current))) return;
    // onFailure=wait tolerates repairable CI failures; closure/cancellation
    // still surfaces as terminal rather than silently waiting forever.
    if (current.outcome === "failure" && isRepairableDependencyFailure(current)) return;
    const claim = { ...current, status: "dispatching" as const, dispatchOwnerPid: process.pid, updatedAt: this.now() };
    if (!this.options.store.replace(current, claim)) return;
    await this.options.changed(claim);
    try {
      const result = await this.options.submit({
        backend: claim.backend, threadId: claim.threadId,
        input: [{ type: "text", text: buildDependencyPrompt(claim) }],
        origin: "automation", messageOrigin: { kind: "pwragent", dependencyId: claim.id },
      });
      if (result.status === "busy") this.busyConsumers.add(identity(claim));
      await this.save(claim, result.status === "busy"
        ? { ...claim, status: "ready" }
        : { ...claim, status: "delivered", turnId: result.turnId });
    } catch (error) {
      // Even a transport error can follow successful backend admission.
      // Retain the claim for review instead of retrying an uncertain side effect.
      await this.save(claim, { ...claim, error: `Continuation delivery needs review: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async save(previous: ThreadDependency, next: ThreadDependency): Promise<ThreadDependency | undefined> {
    // Observation timestamps alone must not cause writes on every PR poll.
    next.evidence = next.evidence.map((entry, index) => {
      const old = previous.evidence[index];
      return old && JSON.stringify({ ...old, observedAt: 0 }) === JSON.stringify({ ...entry, observedAt: 0 }) ? old : entry;
    });
    if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
    next.updatedAt = this.now();
    if (!this.options.store.replace(previous, next)) return undefined;
    await this.options.changed(next);
    return next;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

export function validateDependencyCreate(request: ManageThreadDependenciesRequest): void {
  if (request.action !== "create") throw new Error("action must be create, list, or cancel.");
  if (!Array.isArray(request.conditions) || request.conditions.length < 1 || request.conditions.length > 16) throw new Error("Provide between one and sixteen prerequisite conditions.");
  if (request.mode !== undefined && request.mode !== "all" && request.mode !== "any") throw new Error("mode must be all or any.");
  if (request.onFailure !== undefined && request.onFailure !== "notify" && request.onFailure !== "wait") throw new Error("onFailure must be notify or wait.");
  if (request.continuation !== undefined && (typeof request.continuation !== "string" || request.continuation.length > 8000)) throw new Error("continuation must be text of at most 8000 characters.");
  for (const condition of request.conditions) {
    if (!condition || typeof condition.backend !== "string" || !condition.backend.trim()
      || typeof condition.threadId !== "string" || !condition.threadId.trim()
      || !THREAD_DEPENDENCY_CONDITIONS.includes(condition.when)) throw new Error("Each condition requires backend, threadId, and a supported when value.");
    if (Object.keys(condition).some((field) => !["backend", "threadId", "when", "turnId", "prUrl", "headSha", "title"].includes(field))) throw new Error("Unknown prerequisite condition field.");
    if (condition.title !== undefined && (typeof condition.title !== "string" || condition.title.length > 200)) throw new Error("A prerequisite title must be text of at most 200 characters.");
    for (const value of [condition.turnId, condition.prUrl, condition.headSha]) {
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 2000)) throw new Error("Condition identifiers must be nonempty text of at most 2000 characters.");
    }
    if (condition.when === "turn_completed" && (condition.prUrl || condition.headSha)) throw new Error("PR fields cannot be used for a turn completion condition.");
    if (condition.when !== "turn_completed" && condition.turnId) throw new Error("turnId is only valid for turn completion.");
  }
}

export function evaluateCondition(condition: ThreadDependencyCondition, snapshot: DependencyThreadSnapshot, now: number, turn?: AppServerThreadTurnMetadata): ThreadDependencyEvidence {
  const result = (state: ThreadDependencyEvidence["state"], reason: string, pr?: PrSummary): ThreadDependencyEvidence => ({
    condition, state, reason, observedAt: now,
    ...(pr ? { prUrl: pr.url, headSha: pr.headSha } : {}),
  });
  if (condition.when === "turn_completed") {
    if (turn?.status === "completed") return result("satisfied", `Turn ${turn.id} completed`);
    if (turn?.status && ["failed", "cancelled", "interrupted"].includes(turn.status)) return result("failed", `Turn ${turn.id} ${turn.status}`);
    return result("waiting", `Waiting for turn ${condition.turnId}`);
  }
  const matches = condition.prUrl ? snapshot.prs.filter(({ pr }) => pr.url === condition.prUrl) : snapshot.prs;
  if (matches.length !== 1) return result("waiting", matches.length > 1 ? "Choose a PR URL; the prerequisite has multiple PRs" : "Waiting for a primary-workspace PR");
  const { pr, fetchedAt } = matches[0]!;
  const merged = pr.lifecycleState === "merged" || pr.state === "merged";
  if (condition.when === "ci_passed" && !merged
    && (!pr.headSha || now - fetchedAt > CURRENT_STATUS_MAX_AGE_MS || fetchedAt > now)) return result("waiting", "Waiting for fresh CI status for the current head", pr);
  if (condition.headSha && pr.headSha !== condition.headSha) return result("failed", "The pinned PR head was superseded", pr);
  if (pr.lifecycleState === "closed" || pr.state === "closed") return result("failed", "PR closed without merging", pr);
  if (condition.when === "pr_attached") {
    return result(pr.reviewState === "draft" || pr.state === "draft" ? "waiting" : "satisfied", pr.reviewState === "draft" || pr.state === "draft" ? "PR is still a draft" : "Reviewable PR attached", pr);
  }
  if (condition.when === "pr_merged") return result(merged ? "satisfied" : "waiting", merged ? "PR merged" : "Waiting for PR merge", pr);
  if (pr.reviewState === "draft" || pr.state === "draft") return result("waiting", "PR is still a draft", pr);
  if (pr.mergeState === "conflicting") return result("failed", "Merge conflict", pr);
  if ((pr.checkState ?? pr.state) === "failing") return result("failed", "CI failed", pr);
  if ((pr.checkState ?? pr.state) === "passing" && !pr.checksStillRunning) return result("satisfied", "CI passed for the current head", pr);
  if (merged) return result("failed", "PR merged without known passing CI", pr);
  return result("waiting", "Waiting for CI to pass", pr);
}

const CONDITION_PHRASES: Record<ThreadDependencyCondition["when"], string> = {
  turn_completed: "finishes its turn",
  pr_attached: "has a reviewable PR",
  ci_passed: "passes CI",
  pr_merged: "is merged",
};

export function buildDependencyPrompt(item: ThreadDependency): string {
  const satisfied = item.outcome === "success";
  return [
    `PwrAgent resumed this thread because ${satisfied
      ? item.mode === "any" ? "one of its prerequisites was met" : `its prerequisites were met (all of ${item.conditions.length})`
      : "a prerequisite failed"}.`,
    ...item.evidence.map((entry) => {
      const name = entry.condition.title?.trim() ? `"${entry.condition.title.trim()}"` : `Thread ${entry.condition.threadId}`;
      return `- ${name} ${CONDITION_PHRASES[entry.condition.when]}: ${entry.reason}${entry.prUrl ? `; PR: ${entry.prUrl}` : ""}${entry.headSha ? `; observed head: ${entry.headSha}` : ""}`;
    }),
    "",
    ...satisfied
      ? item.continuation
        ? ["Do what was planned when this dependency was registered:", item.continuation, "",
          "Recheck the prerequisite head before using it; a new commit can arrive after this notification."]
        : ["Continue the previously authorized work. Recheck the prerequisite head before using it; a new commit can arrive after this notification."]
      : ["Report the prerequisite failure. Do not bypass the dependency or begin dependent work; repair only if the operator already authorized it.",
        ...item.continuation ? ["", "The work planned for success, not to start now:", item.continuation] : []],
    "Do not poll this dependency or start a Job Monitor for it.",
    `Dependency ${item.id} (mode ${item.mode}, outcome ${item.outcome}); prerequisites: ${item.conditions.map((condition) => `${condition.backend}:${condition.threadId} (${condition.when})`).join(", ")}.`,
  ].join("\n");
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
