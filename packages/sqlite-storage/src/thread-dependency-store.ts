import type Database from "better-sqlite3";
import type {
  CompactionRecoveryProtection,
  ThreadDependency,
} from "@pwragent/shared/contracts/thread-dependencies";
import { buildLegacyEncodedThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import {
  isThreadDependencyLocalThreadCondition,
  isThreadDependencyMergeBuildCondition,
  threadDependencyDeliveryKey,
  COMPACTION_RECOVERY_COOLDOWN_MS,
  COMPACTION_RECOVERY_WINDOW_MS,
  COMPACTION_RECOVERY_MAX_ATTEMPTS,
  COMPACTION_RECOVERY_MAX_ATTEMPTS_PER_TURN,
} from "@pwragent/shared/contracts/thread-dependencies";
import { mergeCausalMessagingContext } from "@pwragent/shared/messaging-causal-context";

export { THREAD_DEPENDENCY_SCHEMA } from "./state-schema";

/** Candidate-specific admission failures, detected before any registration writes. */
export class ThreadDependencyRegistrationRefusedError extends Error {}

function key(backend: string, threadId: string): string {
  return JSON.stringify([backend, threadId]);
}

function signature(dependency: ThreadDependency): string {
  const file = dependency.conditions[0]?.localFile;
  if (file) return JSON.stringify([dependency.backend, dependency.threadId, dependency.deliver ?? "agent", file.path, file.since]);
  return JSON.stringify([
    dependency.backend, dependency.threadId, dependency.mode,
    dependency.onFailure, dependency.continuation ?? "",
    dependency.deliver ?? "agent", dependency.handoff ?? false,
    dependency.steps ?? [], dependency.holdMerge ?? false,
    dependency.repeat ?? false,
    dependency.wakeOn ?? "",
    dependency.conditions.map((condition) => JSON.stringify([
      condition.backend, condition.threadId, condition.when,
      condition.turnId ?? "", condition.prUrl ?? "", condition.headSha ?? "",
      condition.subject ?? "", condition.target?.instanceId ?? "",
      ...condition.ciRun ? [condition.ciRun] : [],
    ])).sort(),
  ]);
}

/** A prerequisite thread on this machine; one on a peer or a subject is no edge here. */
function localThreadKey(condition: ThreadDependency["conditions"][number], consumer: string): string | undefined {
  // A compaction subscription observes the consumer itself; it never waits
  // for another thread to make progress and contributes no wait-cycle edge.
  if (condition.when === "compaction_completed" || !isThreadDependencyLocalThreadCondition(condition)) return undefined;
  const target = key(condition.backend, condition.threadId);
  // A thread may wait on its own PR's merge build: the forge, not the thread,
  // ends it. Another thread's merge build is an edge like its merge.
  return isThreadDependencyMergeBuildCondition(condition) && target === consumer ? undefined : target;
}

type RecoveryGuard = {
  attempts: { key: string; at: number; submitted?: boolean }[];
  lastAttemptAt?: number;
  lastDispatchAt?: number;
  suspendedAt?: number;
  turnId?: string;
  attemptsInTurn?: number;
};

export class ThreadDependencyStore {
  constructor(private readonly db: Database.Database) {}

  active(): ThreadDependency[] {
    return this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE status IN ('waiting', 'ready', 'dispatching')",
    ).all());
  }

  list(backend: string, threadId: string): ThreadDependency[] {
    return this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE backend = ? AND thread_id = ? ORDER BY CASE WHEN status IN ('waiting', 'ready', 'dispatching') THEN 0 ELSE 1 END, created_at DESC LIMIT 132",
    ).all(backend, threadId));
  }

  /**
   * Every registration on a thread, active or ended, with a condition of one
   * kind. Unlike `list`, history is not capped: an operator's old choice still
   * counts. Only conditions of rare kinds should be read this way.
   */
  listWithCondition(backend: string, threadId: string, when: ThreadDependency["conditions"][number]["when"]): ThreadDependency[] {
    return this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE backend = ? AND thread_id = ? AND EXISTS (SELECT 1 FROM json_each(payload, '$.conditions') WHERE json_extract(value, '$.when') = ?) ORDER BY created_at DESC",
    ).all(backend, threadId, when));
  }

  /** Active wakes plus only the requested ended rows; never read history for a badge. */
  listPendingWakes(backend: string, threadId: string, endedLimit: number): ThreadDependency[] {
    const active = this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE backend = ? AND thread_id = ? AND status IN ('waiting', 'ready') ORDER BY created_at ASC",
    ).all(backend, threadId));
    if (endedLimit === 0) return active;
    return [...active, ...this.decode(this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE backend = ? AND thread_id = ? AND status IN ('delivered', 'cancelled', 'dismissed') ORDER BY json_extract(payload, '$.updatedAt') DESC LIMIT ?",
    ).all(backend, threadId, endedLimit))];
  }

  /** Active registrations elsewhere that name this thread as a prerequisite. */
  dependents(backend: string, threadId: string): ThreadDependency[] {
    const target = key(backend, threadId);
    return this.active()
      .filter((item) => item.conditions.some((condition) => localThreadKey(condition, key(item.backend, item.threadId)) === target))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  get(backend: string, threadId: string, id: string): ThreadDependency | undefined {
    const row = this.db.prepare(
      "SELECT payload FROM thread_dependencies WHERE dependency_id = ? AND backend = ? AND thread_id = ?",
    ).get(id, backend, threadId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ThreadDependency : undefined;
  }

  /**
   * A persisted message origin names this delivery: on its own, or as one
   * member of a combined delivery (`deliveredMessages`).
   */
  hasDeliveryReceipt(item: ThreadDependency): boolean {
    const key = threadDependencyDeliveryKey(item);
    return Boolean(this.db.prepare(
      `SELECT 1 FROM thread_message_origins WHERE backend = ? AND thread_id = ? AND (
         json_extract(payload, '$.dependencyId') = ?
         OR EXISTS (SELECT 1 FROM json_each(payload, '$.deliveredMessages') AS member
           WHERE json_extract(member.value, '$.origin.dependencyId') = ?)
       ) LIMIT 1`,
    ).get(item.backend, item.threadId, key, key));
  }

  private recoveryGuard(target: Pick<ThreadDependency, "backend" | "threadId">): RecoveryGuard {
    const row = this.db.prepare("SELECT payload FROM thread_compaction_recovery_guards WHERE backend = ? AND thread_id = ?")
      .get(target.backend, target.threadId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as RecoveryGuard : { attempts: [] };
  }

  private saveRecoveryGuard(target: Pick<ThreadDependency, "backend" | "threadId">, guard: RecoveryGuard): void {
    this.db.prepare(`INSERT INTO thread_compaction_recovery_guards(backend, thread_id, payload) VALUES (?, ?, ?)
      ON CONFLICT(backend, thread_id) DO UPDATE SET payload = excluded.payload`)
      .run(target.backend, target.threadId, JSON.stringify(guard));
  }

  compactionRecoveryProtection(target: Pick<ThreadDependency, "backend" | "threadId">, now: number): CompactionRecoveryProtection {
    const guard = this.recoveryGuard(target);
    const effectiveNow = Math.max(now, guard.lastAttemptAt ?? now);
    return {
      attemptsInWindow: guard.attempts.filter((attempt) => attempt.at > effectiveNow - COMPACTION_RECOVERY_WINDOW_MS).length,
      attemptsInTurn: guard.attemptsInTurn ?? 0,
      ...(guard.lastAttemptAt !== undefined ? { cooldownUntil: guard.lastAttemptAt + COMPACTION_RECOVERY_COOLDOWN_MS } : {}),
      ...(guard.suspendedAt !== undefined ? { suspendedAt: guard.suspendedAt } : {}),
    };
  }

  isCompactionRecoveryReserved(item: ThreadDependency, now: number): boolean {
    const guard = this.recoveryGuard(item);
    return guard.suspendedAt === undefined
      && (guard.lastDispatchAt === undefined || now >= guard.lastDispatchAt + COMPACTION_RECOVERY_COOLDOWN_MS)
      && guard.attempts.some((attempt) => attempt.key === threadDependencyDeliveryKey(item) && !attempt.submitted);
  }

  /** Final RPC admission consumes an unsubmitted reservation at dispatch time. */
  admitCompactionRecovery(item: ThreadDependency, now: number): boolean {
    return this.db.transaction(() => {
      if (JSON.stringify(this.get(item.backend, item.threadId, item.id)) !== JSON.stringify(item)
        || this.isConsumerArchived(item) || !this.isCompactionRecoveryReserved(item, now)) return false;
      const guard = this.recoveryGuard(item);
      const effectiveNow = Math.max(now, guard.lastAttemptAt ?? now);
      this.saveRecoveryGuard(item, {
        ...guard,
        // A delayed busy retry keeps its slot in the rolling window from the
        // actual dispatch, rather than letting a stale allocation age out early.
        attempts: guard.attempts.map(attempt => attempt.key === threadDependencyDeliveryKey(item)
          ? { ...attempt, at: effectiveNow, submitted: true } : attempt),
        lastAttemptAt: effectiveNow, lastDispatchAt: effectiveNow,
      });
      return true;
    }).immediate();
  }

  /** Reserve the thread-wide budget atomically with the existing dispatch claim. */
  claimCompactionRecovery(previous: ThreadDependency, claim: ThreadDependency, now: number): "claimed" | "lost" | "cooldown" | "suspended" {
    return this.db.transaction(() => {
      if (JSON.stringify(this.get(previous.backend, previous.threadId, previous.id)) !== JSON.stringify(previous)) return "lost";
      const guard = this.recoveryGuard(previous);
      const deliveryKey = threadDependencyDeliveryKey(claim);
      if (guard.suspendedAt !== undefined) return "suspended";
      const reserved = guard.attempts.find((attempt) => attempt.key === deliveryKey);
      if (reserved?.submitted || (guard.lastDispatchAt !== undefined && now < guard.lastDispatchAt + COMPACTION_RECOVERY_COOLDOWN_MS)) return "cooldown";
      if (!reserved) {
        const effectiveNow = Math.max(now, guard.lastAttemptAt ?? now);
        const attempts = guard.attempts.filter((attempt) => attempt.at > effectiveNow - COMPACTION_RECOVERY_WINDOW_MS);
        const attemptsInTurn = guard.turnId === claim.compaction?.turnId ? guard.attemptsInTurn ?? 0 : 0;
        if (attempts.length >= COMPACTION_RECOVERY_MAX_ATTEMPTS || attemptsInTurn >= COMPACTION_RECOVERY_MAX_ATTEMPTS_PER_TURN) {
          this.saveRecoveryGuard(previous, { ...guard, suspendedAt: effectiveNow });
          return "suspended";
        }
        if (guard.lastAttemptAt !== undefined && now < guard.lastAttemptAt + COMPACTION_RECOVERY_COOLDOWN_MS) return "cooldown";
        this.saveRecoveryGuard(previous, {
          ...guard,
          attempts: [...attempts, { key: deliveryKey, at: effectiveNow }], lastAttemptAt: effectiveNow,
          turnId: claim.compaction?.turnId, attemptsInTurn: attemptsInTurn + 1,
        });
      }
      // This immediate transaction owns the row after the read above.
      if (!this.replace(previous, claim)) throw new Error("Compaction recovery claim changed inside its reservation transaction.");
      return "claimed";
    }).immediate();
  }

  rearmCompactionRecovery(target: Pick<ThreadDependency, "backend" | "threadId">): void {
    this.db.prepare("DELETE FROM thread_compaction_recovery_guards WHERE backend = ? AND thread_id = ?")
      .run(target.backend, target.threadId);
  }

  register(candidate: ThreadDependency): ThreadDependency {
    return this.registerReplacing(candidate, () => false).dependency;
  }

  /**
   * Registers `candidate` and, in the same immediate transaction, cancels
   * each waiting or ready registration `supersedes` accepts, recording the
   * replacement. A claim being dispatched or reviewed is never replaced.
   */
  registerReplacing(candidate: ThreadDependency, supersedes: (existing: ThreadDependency) => boolean): {
    dependency: ThreadDependency;
    superseded: ThreadDependency[];
  } {
    return this.db.transaction(() => {
      if (this.isConsumerArchived(candidate)) throw new ThreadDependencyRegistrationRefusedError("Cannot register a continuation for an archived thread.");
      if (candidate.automatic && candidate.conditions.some(isThreadDependencyMergeBuildCondition) && this.isConsumerLocked(candidate)) {
        throw new ThreadDependencyRegistrationRefusedError("Cannot register an automatic merge build watch for a locked thread.");
      }
      if (candidate.conditions[0]?.resourceCheckout) {
        const existing = this.get(candidate.backend, candidate.threadId, candidate.id);
        if (existing) return { dependency: existing, superseded: [] };
      }
      const file = candidate.conditions[0]?.localFile;
      if (file) {
        // A marker can remain on disk indefinitely. Re-registering the same
        // attempt after delivery must not admit another turn.
        const [delivered] = this.decode(this.db.prepare(`
          SELECT payload FROM thread_dependencies
          WHERE backend = ? AND thread_id = ? AND status IN ('delivered', 'dismissed')
            AND json_extract(payload, '$.conditions[0].localFile.path') = ?
            AND json_extract(payload, '$.conditions[0].localFile.since') = ?
            AND coalesce(json_extract(payload, '$.deliver'), 'agent') = ?
          LIMIT 1`
        ).all(candidate.backend, candidate.threadId, file.path, file.since, candidate.deliver ?? "agent"));
        if (delivered) return { dependency: delivered, superseded: [] };
      }
      const current = this.active();
      const unresolved = current.find((item) => item.backend === candidate.backend && item.threadId === candidate.threadId
        && item.status === "dispatching" && item.error);
      if ((candidate.deliver ?? "agent") === "agent" && unresolved) {
        throw new ThreadDependencyRegistrationRefusedError(`Continuation delivery needs review (${unresolved.id}). List this thread's dependencies and ask the operator to inspect the delivery before creating another agent continuation. Dismiss only after operator review; dismissal does not cancel a turn.`);
      }
      const duplicate = current.find((item) => signature(item) === signature(candidate));
      if (duplicate) {
        // One wake answers both requests, so it carries no more authority
        // than the narrower one. A claim in flight already has its origin.
        const merged = { ...duplicate, ...mergeCausalMessagingContext([duplicate, candidate]) };
        if ((duplicate.status !== "waiting" && duplicate.status !== "ready")
          || JSON.stringify(merged) === JSON.stringify(duplicate)) return { dependency: duplicate, superseded: [] };
        const narrowed = { ...merged, updatedAt: candidate.createdAt };
        if (!this.replace(duplicate, narrowed)) throw new Error("Dependency changed while registering its duplicate. Try again.");
        return { dependency: narrowed, superseded: [] };
      }
      const superseded = current.filter((item) => item.backend === candidate.backend && item.threadId === candidate.threadId
        && (item.status === "waiting" || item.status === "ready") && supersedes(item))
        .map((item) => ({ ...item, status: "cancelled" as const, supersededBy: candidate.id, updatedAt: candidate.createdAt }));
      const retired = new Set(superseded.map((item) => item.id));
      const active = current.filter((item) => !retired.has(item.id));
      if (active.length >= 512) throw new Error("There are already 512 active dependencies. Cancel an existing dependency first.");
      if (active.filter((item) => item.backend === candidate.backend && item.threadId === candidate.threadId).length >= 32) throw new ThreadDependencyRegistrationRefusedError("This thread already has 32 active dependencies. Cancel an existing dependency first.");
      const edges = new Map<string, Set<string>>();
      for (const item of [...active, candidate]) {
        const consumer = key(item.backend, item.threadId);
        const targets = edges.get(consumer) ?? new Set<string>();
        item.conditions.forEach((condition) => {
          const target = localThreadKey(condition, consumer);
          if (target) targets.add(target);
        });
        edges.set(consumer, targets);
      }
      const consumer = key(candidate.backend, candidate.threadId);
      const reachesConsumer = (node: string, seen: Set<string>): boolean => {
        if (node === consumer) return true;
        if (seen.has(node)) return false;
        seen.add(node);
        return [...(edges.get(node) ?? [])].some((target) => reachesConsumer(target, seen));
      };
      if (candidate.conditions.some((condition) => {
        const target = localThreadKey(condition, consumer);
        return target !== undefined && reachesConsumer(target, new Set());
      })) {
        throw new ThreadDependencyRegistrationRefusedError("This dependency would create a thread dependency cycle.");
      }
      for (const item of superseded) {
        const previous = current.find((entry) => entry.id === item.id)!;
        if (!this.replace(previous, item)) throw new Error("Dependency changed while registering its replacement. Try again.");
      }
      this.db.prepare(
        "INSERT INTO thread_dependencies(dependency_id, backend, thread_id, status, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(candidate.id, candidate.backend, candidate.threadId, candidate.status, candidate.createdAt, JSON.stringify(candidate));
      return { dependency: candidate, superseded };
    }).immediate();
  }

  isConsumerArchived(target: Pick<ThreadDependency, "backend" | "threadId">): boolean {
    const row = this.db.prepare(`SELECT
      (json_type(payload, '$.archiveRetentionStartedAt') IS NOT NULL
        OR json_type(payload, '$.archiveTombstonedAt') IS NOT NULL) AS archived
      FROM threads WHERE thread_id = ?`).get(buildLegacyEncodedThreadIdentityKey(target.backend, target.threadId)) as
      { archived: number } | undefined;
    return row?.archived === 1;
  }

  isConsumerLocked(target: Pick<ThreadDependency, "backend" | "threadId">): boolean {
    const row = this.db.prepare(`SELECT 1 FROM threads
      WHERE thread_id = ? AND json_type(payload, '$.lock') = 'object'`)
      .get(buildLegacyEncodedThreadIdentityKey(target.backend, target.threadId));
    return row !== undefined;
  }

  /** Archive revokes the consumer's subscriptions, including an unsubmitted claim. */
  retireForArchivedThread(target: Pick<ThreadDependency, "backend" | "threadId">, now: number): ThreadDependency[] {
    const retired = this.decode(this.db.prepare(`SELECT payload FROM thread_dependencies
      WHERE backend = ? AND thread_id = ? AND status IN ('waiting', 'ready', 'dispatching')`)
      .all(target.backend, target.threadId));
    if (retired.length === 0) return [];
    this.db.prepare(`UPDATE thread_dependencies SET status = 'cancelled',
      payload = json_set(payload, '$.status', 'cancelled', '$.updatedAt', ?)
      WHERE backend = ? AND thread_id = ? AND status IN ('waiting', 'ready', 'dispatching')`)
      .run(now, target.backend, target.threadId);
    return retired.map((item) => ({ ...item, status: "cancelled", updatedAt: now }));
  }

  /** One immediate transaction: an operator card commits with its claim. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /** Compare-and-swap also arbitrates dispatch across processes sharing a profile. */
  replace(previous: ThreadDependency, next: ThreadDependency): boolean {
    if (JSON.stringify(previous) === JSON.stringify(next)) return true;
    return this.db.prepare(
      "UPDATE thread_dependencies SET status = ?, payload = ? WHERE dependency_id = ? AND payload = ?",
    ).run(next.status, JSON.stringify(next), previous.id, JSON.stringify(previous)).changes === 1;
  }

  cancel(backend: string, threadId: string, id: string, now: number): ThreadDependency {
    const item = this.get(backend, threadId, id);
    if (!item) throw new Error("Dependency not found for this thread.");
    if (item.status === "cancelled") return item;
    if (item.status === "dispatching" || item.status === "delivered") {
      throw new Error("The continuation has already been admitted and cannot be cancelled here.");
    }
    if (item.status === "dismissed") throw new Error("This dependency was already dismissed after review.");
    const next = { ...item, status: "cancelled" as const, updatedAt: now };
    if (!this.replace(item, next)) {
      throw new Error("Dependency changed while cancelling. Read its current state first.");
    }
    return next;
  }

  dismiss(backend: string, threadId: string, id: string, now: number): ThreadDependency {
    return this.dismissMany(backend, threadId, [id], now)[0]!;
  }

  /**
   * Retires reviewed uncertain deliveries on one thread in one immediate
   * transaction: all of them, or none when any has changed. Nothing is
   * replayed or cancelled; a turn that was admitted keeps running.
   */
  dismissMany(backend: string, threadId: string, ids: readonly string[], now: number): ThreadDependency[] {
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("Name each uncertain delivery to dismiss once.");
    return this.db.transaction(() => ids.map((id) => {
      const item = this.get(backend, threadId, id);
      if (!item || item.status !== "dispatching" || !item.error) throw new Error("Only an uncertain delivery can be dismissed after review.");
      const next = { ...item, status: "dismissed" as const, updatedAt: now };
      if (!this.replace(item, next)) throw new Error("Dependency changed while dismissing. Read its current state first.");
      return next;
    })).immediate();
  }

  private decode(rows: unknown[]): ThreadDependency[] {
    return rows.map((row) => JSON.parse((row as { payload: string }).payload) as ThreadDependency);
  }
}
