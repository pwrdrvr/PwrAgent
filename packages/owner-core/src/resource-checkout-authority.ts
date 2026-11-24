import type { ResourceCheckoutActionRequest, ResourceCheckoutActionResult } from "@pwragent/shared/contracts/resource-checkouts";
import type {
  CheckoutActor, CheckoutDefinition, CheckoutDomainRecord, CheckoutGrant,
  CheckoutStore, CheckoutWaiter,
} from "./resource-checkout-storage";

export const MIN_CHECKOUT_CONTINUATION_HOLD_MS = 5_000;
export const MAX_CHECKOUT_RENEWALS = 1;
const MAX_QUEUE_LENGTH = 100;
export const MAX_CHECKOUT_HOLD_MS = 4 * 60 * 60 * 1_000;

export type CheckoutToken = {
  resourceId: string;
  allocationId: string;
  epoch: number;
  generation: number;
};

export type CheckoutStatus = {
  receipt: ResourceCheckoutActionResult;
} & (
  | { state?: undefined }
  | { state: "queued"; position: number; durationMs: number }
  | { state: "ended" }
  | { state: CheckoutGrant["state"]; allocationId: string; generation: number; authorityEpoch: number; deadlineAt: number; durationMs: number }
);

/** The saved definition differs from the configured one in owner, epoch, key or capacity. */
export class CheckoutDefinitionConflictError extends Error {
  constructor() {
    super("The durable definition conflicts with the configured authority or capacity.");
    this.name = "CheckoutDefinitionConflictError";
  }
}

type OwnershipAction = Extract<ResourceCheckoutActionRequest, { kind: "resolve_ownership" }>;

function executionOwner(grant: CheckoutGrant): CheckoutActor {
  return grant.executor ?? grant.actor;
}

type FenceProof = (job: NonNullable<CheckoutGrant["job"]>) => boolean;

type Failure = Extract<ResourceCheckoutActionResult, { outcome: "rejected" }>;
export function rejectCheckout(reason: Failure["reason"], message: string): Failure {
  return { outcome: "rejected", reason, message };
}

/**
 * Earliest time `grants` will free enough capacity for `needed` units, plus
 * spare capacity remaining at that time beyond `needed`.
 */
function headReservationWindow(
  grants: readonly CheckoutGrant[],
  available: number,
  needed: number,
): { shadowTime: number; extraAtShadow: number } | undefined {
  const ordered = [...grants].sort((a, b) => a.deadlineAt - b.deadlineAt);
  let projected = available;
  let shadowTime: number | undefined;
  for (const grant of ordered) {
    projected += grant.units;
    if (projected >= needed) {
      shadowTime = grant.deadlineAt;
      break;
    }
  }
  if (shadowTime === undefined) return undefined;
  const totalAtShadow = available
    + ordered
      .filter((grant) => grant.deadlineAt <= shadowTime)
      .reduce((sum, grant) => sum + grant.units, 0);
  return { shadowTime, extraAtShadow: totalAtShadow - needed };
}

function wake(record: CheckoutDomainRecord, now: number): void {
  const { definition, queue, grants } = record;
  if (grants.some((grant) => grant.state === "recovery_required")) return;
  let available = definition.capacity - grants.reduce((sum, grant) => sum + grant.units, 0);
  while (queue[0] && queue[0].units <= available) {
    const next = queue.shift()!;
    available -= next.units;
    grants.push({
      ...next, generation: ++record.generation, grantedAt: now, renewals: 0,
      deadlineAt: now + next.durationMs, state: "granted",
    });
  }
  // EASY backfilling: when the head request waits for capacity on a counted
  // resource, allow later waiters that fit now AND cannot delay the head's
  // guaranteed shadow start time (either they finish by `shadowTime` or fit
  // within spare slots at `shadowTime`). Renewals are refused while any waiter
  // is queued, so backfilled grants cannot extend past `shadowTime`.
  if (!definition.counted || queue.length <= 1 || available <= 0) return;
  const reservation = headReservationWindow(grants, available, queue[0].units);
  if (!reservation) return;
  const { shadowTime } = reservation;
  let extraAtShadow = reservation.extraAtShadow;
  let index = 1;
  while (index < queue.length && available > 0) {
    const candidate = queue[index]!;
    const finishesBeforeHead = now + candidate.durationMs <= shadowTime;
    const fitsInSpareAtShadow = candidate.units <= extraAtShadow;
    if (candidate.units <= available && (finishesBeforeHead || fitsInSpareAtShadow)) {
      queue.splice(index, 1);
      available -= candidate.units;
      if (!finishesBeforeHead) extraAtShadow -= candidate.units;
      grants.push({
        ...candidate, generation: ++record.generation, grantedAt: now, renewals: 0,
        deadlineAt: now + candidate.durationMs, state: "granted",
      });
    } else {
      index++;
    }
  }
}

function reconcile(record: CheckoutDomainRecord, now: number): boolean {
  const expired = record.grants.filter((grant) => grant.state !== "recovery_required" && grant.deadlineAt <= now);
  if (!expired.length) return false;
  for (const grant of expired) {
    if (grant.job) {
      grant.state = "recovery_required";
      grant.recoverySince = now;
    } else {
      record.grants.splice(record.grants.indexOf(grant), 1);
    }
  }
  wake(record, now);
  return true;
}

function applyCheckout(
  record: CheckoutDomainRecord, actor: CheckoutActor,
  action: Exclude<ResourceCheckoutActionRequest, { kind: "register_definition" }>, now: number, newId: () => string, proveFenced?: FenceProof, executor?: CheckoutActor,
): ResourceCheckoutActionResult {
  if (record.definition.publication !== "published") {
    return rejectCheckout("pending_registration", "The configured authority has not published this definition.");
  }
  if (action.kind === "request") {
    if (record.grants.some((grant) => grant.state === "recovery_required")) {
      return rejectCheckout("fencing_required", "An owned job still needs verified cleanup.");
    }
    const { capacity, maxHoldMs } = record.definition;
    const units = action.units ?? capacity;
    if (!Number.isSafeInteger(action.expectedDurationMs) || action.expectedDurationMs < 1 || action.expectedDurationMs > maxHoldMs
      || !Number.isSafeInteger(units) || units < 1 || units > capacity) {
      return rejectCheckout("policy", "The requested duration or units exceed the resource policy.");
    }
    if (record.queue.length >= MAX_QUEUE_LENGTH) return rejectCheckout("policy", "The checkout queue is full.");
    const waiter: CheckoutWaiter = {
      id: newId(), actor, purpose: action.purpose, units, durationMs: action.expectedDurationMs, requestedAt: now,
    };
    record.queue.push(waiter);
    wake(record, now);
    const grant = record.grants.find((entry) => entry.id === waiter.id);
    return grant
      ? { outcome: "granted", allocationId: grant.id, generation: grant.generation }
      : { outcome: "queued", queueEntryId: waiter.id, position: record.queue.length };
  }
  if (action.kind === "cancel_request") {
    const index = record.queue.findIndex((entry) => entry.id === action.queueEntryId);
    if (index < 0) return rejectCheckout("not_applicable", "The request is no longer queued.");
    if (record.queue[index].actor.key !== actor.key) return rejectCheckout("not_authorized", "Only the requester can cancel.");
    record.queue.splice(index, 1);
    wake(record, now);
    return { outcome: "accepted" };
  }
  if (!("allocationId" in action)) return rejectCheckout("not_applicable", "No ownership candidate can be selected.");
  const grant = record.grants.find((entry) => entry.id === action.allocationId);
  if (!grant || grant.generation !== action.generation) {
    return rejectCheckout("stale_generation", "The allocation or generation is no longer current.");
  }
  if (action.kind === "fence" || action.kind === "verify_cleanup" || action.kind === "administrative_release") {
    if (!actor.manage || actor.holder.kind !== "operator") return rejectCheckout("not_authorized", "Only an operator can verify recovery.");
    if (!grant.job || grant.state !== "recovery_required") return rejectCheckout("not_applicable", "This checkout has no job in recovery.");
    if (action.kind !== "fence" && grant.fencingVerifiedAt === undefined) {
      return rejectCheckout("fencing_required", "Fence the old workload before releasing capacity.");
    }
    if (!proveFenced?.(grant.job)) {
      return rejectCheckout("fencing_required", "The owned process group is still present or its identity could not be verified.");
    }
    if (action.kind === "fence") {
      grant.fencingVerifiedAt = now;
      return { outcome: "accepted", message: "The owned process group is gone." };
    }
    record.grants.splice(record.grants.indexOf(grant), 1);
    record.cleanupVerifiedAt = now;
    wake(record, now);
    return { outcome: "accepted" };
  }
  if (grant.actor.key !== actor.key) return rejectCheckout("not_authorized", "The caller does not own this checkout.");
  if (action.kind === "delegate_execution") {
    if (action.authorityEpoch !== record.definition.epoch) return rejectCheckout("stale_generation", "The authority epoch changed.");
    if (!executor || executor.key === actor.key || actor.holder.kind !== "thread" || executor.holder.kind !== "thread") {
      return rejectCheckout("not_authorized", "The executor must be a distinct authorized thread.");
    }
    if (grant.state !== "granted" || grant.job || (grant.executor && grant.executor.key !== executor.key)) {
      return rejectCheckout("conflict", "The checkout already has an executor or an owned job.");
    }
    grant.executor = executor;
    return { outcome: "accepted" };
  }
  if (action.kind === "extend") {
    if (grant.job?.provider || (grant.state !== "granted" && grant.state !== "active")) {
      return rejectCheckout("not_applicable", "This checkout cannot be renewed in its current state.");
    }
    const deadline = Math.min(grant.deadlineAt + grant.durationMs, grant.grantedAt + record.definition.maxHoldMs);
    if (record.queue.length || grant.renewals >= MAX_CHECKOUT_RENEWALS || deadline <= grant.deadlineAt) {
      return rejectCheckout("renewal_limit", "The checkout reached its renewal limit or another requester is waiting.");
    }
    grant.deadlineAt = deadline;
    grant.renewals++;
    return { outcome: "accepted" };
  }
  if (action.kind !== "release") return rejectCheckout("fencing_required", "The executor must verify cleanup of the owned job.");
  if (grant.job) {
    if (grant.state !== "recovery_required") grant.state = "draining";
    return { outcome: "accepted", message: "Capacity remains reserved until the executor verifies cleanup." };
  }
  record.grants = record.grants.filter((entry) => entry.id !== grant.id);
  wake(record, now);
  return { outcome: "accepted" };
}

export class ResourceCheckoutAuthority {
  constructor(private readonly store: CheckoutStore, private readonly now: () => number, private readonly newId: () => string) {}

  ensure(definition: CheckoutDefinition, options?: { machineCpuPool: true }): void {
    this.store.change((tx) => {
      const record = tx.read(definition.resourceId);
      if (!record) {
        tx.save({ definition, generation: 0, grants: [], queue: [] });
        return;
      }
      const saved = record.definition;
      if (saved.authorityId !== definition.authorityId || saved.epoch !== definition.epoch
        || saved.canonicalKey !== definition.canonicalKey) {
        throw new CheckoutDefinitionConflictError();
      }
      if (options?.machineCpuPool && saved.scope === "machine" && definition.scope === "machine"
        && saved.publication === "published" && definition.revision === 2 && definition.counted) {
        // The first profile to initialize the counted pool sets its capacity.
        // Later CPU samples cannot resize a shared pool with live reservations.
        if (saved.counted && saved.revision === definition.revision) return;
        if (saved.revision === 1 && !saved.counted && saved.capacity === 1) {
          // Preserve the earlier whole-machine holds, tokens and FIFO order.
          for (const hold of [...record.grants, ...record.queue]) hold.units = definition.capacity;
          record.definition = definition;
          tx.save(record);
          return;
        }
      }
      if (saved.capacity !== definition.capacity) {
        throw new CheckoutDefinitionConflictError();
      }
      if (definition.revision > saved.revision) {
        record.definition = definition;
        tx.save(record);
      }
    });
  }

  /**
   * Apply an operator's ownership resolution once, under its request key. A
   * retry with the same key returns the recorded result; without `apply`
   * (the conflict is already gone) only a recorded result is returned.
   */
  resolveOwnership(
    actor: CheckoutActor,
    action: OwnershipAction,
    apply?: (record: CheckoutDomainRecord, now: number) => void,
  ): ResourceCheckoutActionResult {
    const fingerprint = JSON.stringify(action);
    return this.store.change((tx) => {
      const previous = tx.receipt(actor.key, action.idempotencyKey);
      if (previous) return previous.fingerprint === fingerprint ? previous.result
        : rejectCheckout("conflict", "This request key was already used for another action.");
      const record = tx.read(action.resourceId);
      if (!apply || !record) return rejectCheckout("not_applicable", "Ownership of this resource is already resolved.");
      apply(record, this.now());
      tx.save(record);
      const result: ResourceCheckoutActionResult = { outcome: "accepted", message: "Ownership resolved." };
      tx.recordReceipt(actor.key, action.idempotencyKey, { result, fingerprint, resourceId: action.resourceId });
      return result;
    });
  }

  records(resourceId?: string): CheckoutDomainRecord[] {
    const now = this.now();
    const matches = (record: CheckoutDomainRecord) => resourceId === undefined || record.definition.resourceId === resourceId;
    const existing = this.store.readAll().filter(matches);
    if (!existing.some(({ grants }) => grants.some((grant) => grant.state !== "recovery_required" && grant.deadlineAt <= now))) {
      return existing;
    }
    return this.store.change((tx) => {
      const records = tx.list().filter(matches);
      for (const record of records) {
        if (reconcile(record, this.now())) tx.save(record);
      }
      return records;
    });
  }

  status(actor: CheckoutActor, key: string, resourceId: string): CheckoutStatus | undefined {
    const receipt = this.store.receipt(actor.key, key);
    if (!receipt || receipt.resourceId !== resourceId) return undefined;
    const { result } = receipt;
    const id = result.outcome === "queued" ? result.queueEntryId : result.outcome === "granted" ? result.allocationId : undefined;
    if (!id) return { receipt: result };
    const record = this.records(resourceId)[0];
    const grant = record?.grants.find((entry) => entry.id === id && entry.actor.key === actor.key);
    if (grant && record) return {
      receipt: result, state: grant.state, allocationId: grant.id, generation: grant.generation,
      authorityEpoch: record.definition.epoch, deadlineAt: grant.deadlineAt, durationMs: grant.durationMs,
    };
    const position = record?.queue.findIndex((entry) => entry.id === id && entry.actor.key === actor.key) ?? -1;
    return position < 0 ? { receipt: result, state: "ended" as const } : {
      receipt: result, state: "queued" as const, position: position + 1, durationMs: record!.queue[position]!.durationMs,
    };
  }

  perform(actor: CheckoutActor, action: ResourceCheckoutActionRequest, options?: { draft?: CheckoutDefinition; proveFenced?: FenceProof; draftOwnerInstanceId?: string; executor?: CheckoutActor }): ResourceCheckoutActionResult {
    const draft = options?.draft;
    const fingerprint = JSON.stringify(action);
    return this.store.change((tx) => {
      const previous = tx.receipt(actor.key, action.idempotencyKey);
      if (previous) return previous.fingerprint === fingerprint ? previous.result
        : rejectCheckout("conflict", "This request key was already used for another action.");
      const now = this.now();
      const resourceId = action.kind === "register_definition" ? draft?.resourceId : action.resourceId;
      const record = resourceId ? tx.read(resourceId) : undefined;
      let result: ResourceCheckoutActionResult;
      if (action.kind === "register_definition") {
        if (!draft || !actor.manage) return rejectCheckout("not_authorized", "Definition registration requires operator authorization.");
        if (record) return rejectCheckout("conflict", "This canonical identity already has a definition.");
        tx.save({ definition: draft, generation: 0, grants: [], queue: [] });
        result = { outcome: "accepted" };
      } else {
        if (!record || (record.definition.publication === "pending_registration" &&
          (!record.definition.draftOwnerInstanceId || record.definition.draftOwnerInstanceId !== options?.draftOwnerInstanceId))) {
          return rejectCheckout("not_applicable", "The authority has no record for this resource.");
        }
        const reconciled = reconcile(record, now);
        result = applyCheckout(record, actor, action, now, this.newId, options?.proveFenced, options?.executor);
        if (reconciled || result.outcome !== "rejected") tx.save(record);
      }
      tx.recordReceipt(actor.key, action.idempotencyKey, { result, fingerprint, resourceId: resourceId! });
      return result;
    });
  }

  reconcilePriorMachineBoot(resourceId: string, bootId: string): void {
    this.store.change((tx) => {
      const record = tx.read(resourceId);
      if (!record) return;
      const grants = record.grants.filter((entry) => !entry.job?.machineBootId || entry.job.machineBootId === bootId);
      if (grants.length === record.grants.length) return;
      record.grants = grants;
      const now = this.now();
      record.cleanupVerifiedAt = now;
      reconcile(record, now);
      wake(record, now);
      tx.save(record);
    });
  }

  admitLocalJob(resourceId: string, actor: CheckoutActor, purpose: string, job: NonNullable<CheckoutGrant["job"]>, retainExistingGrant = false): CheckoutToken | undefined {
    return this.store.change((tx) => {
      const record = tx.read(resourceId);
      if (!record || record.definition.publication !== "published") return undefined;
      const now = this.now();
      const changed = reconcile(record, now);
      const candidates = record.grants.filter((entry) => executionOwner(entry).key === actor.key && entry.state === "granted" && !entry.job);
      if (candidates.length > 1) {
        throw new Error("Multiple idle machine reservations belong to this thread. Release the extra reservations before launching a managed job.");
      }
      let grant = candidates[0];
      const retainGrant = !!grant && retainExistingGrant;
      if (!grant && !record.grants.length && !record.queue.length) {
        record.queue.push({
          actor, id: this.newId(), requestedAt: now, purpose, units: record.definition.capacity,
          durationMs: record.definition.maxHoldMs,
        });
        wake(record, now);
        grant = record.grants[0];
      }
      if (!grant) {
        if (changed) tx.save(record);
        return undefined;
      }
      grant.state = "preparing";
      grant.job = retainGrant ? { ...job, retainGrant } : job;
      if (!retainGrant) grant.purpose = purpose;
      tx.save(record);
      return { resourceId, allocationId: grant.id, epoch: record.definition.epoch, generation: grant.generation };
    });
  }

  delegationIsCurrent(
    actor: CheckoutActor,
    action: Extract<ResourceCheckoutActionRequest, { kind: "delegate_execution" }>,
    executor: CheckoutActor,
  ): boolean {
    const record = this.store.readAll().find(({ definition }) => definition.resourceId === action.resourceId);
    return record?.definition.epoch === action.authorityEpoch && record.grants.some((grant) =>
      grant.id === action.allocationId && grant.generation === action.generation
      && grant.actor.key === actor.key && grant.executor?.key === executor.key
      && grant.state === "granted" && !grant.job && grant.deadlineAt > this.now());
  }

  executionDeadline(actor: CheckoutActor, token: CheckoutToken): number | undefined {
    const record = this.store.readAll().find(({ definition }) => definition.resourceId === token.resourceId);
    if (record?.definition.epoch !== token.epoch) return undefined;
    return record.grants.find((grant) => grant.id === token.allocationId && grant.generation === token.generation
      && grant.state === "granted" && grant.deadlineAt > this.now() && executionOwner(grant).key === actor.key)?.deadlineAt;
  }

  providerJob(actor: CheckoutActor, token: CheckoutToken): CheckoutGrant["job"] {
    const record = this.records(token.resourceId)[0];
    if (record?.definition.epoch !== token.epoch) return undefined;
    return record.grants.find((grant) => grant.id === token.allocationId && grant.generation === token.generation
      && grant.state === "recovery_required" && (executionOwner(grant).key === actor.key
        || (actor.holder.kind === "operator" && actor.manage)))?.job;
  }

  jobMayRun(token: CheckoutToken, jobId: string): boolean {
    const record = this.records().find(({ definition }) => definition.resourceId === token.resourceId);
    const grant = record?.grants.find((entry) => entry.id === token.allocationId && entry.generation === token.generation);
    return record?.definition.epoch === token.epoch && grant?.job?.id === jobId
      && (grant.state === "preparing" || grant.state === "active") && grant.deadlineAt > this.now();
  }

  beginJobDrain(token: CheckoutToken, jobId: string): boolean {
    return this.changeJob(token, (_record, grant) => {
      if (grant.job?.id !== jobId) return false;
      if (grant.state === "recovery_required" || grant.state === "draining") return "unchanged";
      grant.state = "draining";
      return true;
    });
  }

  markJobRecovery(token: CheckoutToken, jobId: string): boolean {
    return this.changeJob(token, (_record, grant, now) => {
      if (grant.job?.id !== jobId || grant.state === "recovery_required") return false;
      grant.state = "recovery_required";
      grant.recoverySince = now;
      return true;
    });
  }

  /** Persist ownership before the adapter can launch any effect. */
  bindJob(actor: CheckoutActor, token: CheckoutToken, job: NonNullable<CheckoutGrant["job"]>): boolean {
    return this.changeJob(token, (record, grant) => {
      if (executionOwner(grant).key !== actor.key || grant.state !== "granted" || grant.job
        || (job.provider && job.provider.deadlineAt !== grant.deadlineAt)) return false;
      grant.job = job;
      grant.state = "preparing";
      return true;
    });
  }

  activateJob(token: CheckoutToken, jobId: string, processGroupId?: number): boolean {
    return this.changeJob(token, (_record, grant) => {
      if (grant.job?.id !== jobId || grant.state !== "preparing") return false;
      grant.state = "active";
      grant.job.processGroupId = processGroupId;
      return true;
    });
  }

  /** Called only by the executor after it has proved all owned effects drained. */
  finishJob(token: CheckoutToken, jobId: string, cleanupReceipt?: string): boolean {
    return this.changeJob(token, (record, grant, now) => {
      if (grant.job?.id !== jobId) return false;
      if (grant.job.retainGrant && (grant.state === "active" || grant.state === "preparing")) {
        grant.job = undefined;
        grant.state = "granted";
      } else {
        record.grants.splice(record.grants.indexOf(grant), 1);
        wake(record, now);
      }
      record.cleanupVerifiedAt = now;
      record.cleanupReceipt = cleanupReceipt;
      return true;
    });
  }

  private changeJob(token: CheckoutToken, change: (record: CheckoutDomainRecord, grant: CheckoutGrant, now: number) => boolean | "unchanged"): boolean {
    return this.store.change((tx) => {
      const record = tx.read(token.resourceId);
      if (!record || record.definition.epoch !== token.epoch) return false;
      const now = this.now();
      const reconciled = reconcile(record, now);
      const grant = record.grants.find((entry) => entry.id === token.allocationId && entry.generation === token.generation);
      const changed = !!grant && change(record, grant, now);
      if (changed === true || reconciled) tx.save(record);
      return !!changed;
    });
  }
}
