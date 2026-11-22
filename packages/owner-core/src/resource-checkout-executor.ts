import { ResourceCheckoutAuthority, type CheckoutToken } from "./resource-checkout-authority";
import type { CheckoutActor } from "./resource-checkout-storage";

export type CheckoutExecutionPolicy = {
  allowedActors: readonly string[];
  adapterId: string;
  maxCostMinorUnits: number;
  finalState: string;
};

export type CheckoutExecution = CheckoutToken & {
  jobId: string;
  deadlineAt: number;
  maxCostMinorUnits: number;
  finalState: string;
};

export interface CheckoutProviderAdapter {
  id: string;
  scope?: string;
  accepts?(execution: CheckoutExecution): boolean;
  /** Implementations keep effects scoped to this execution, even after cancellation. */
  prepare(execution: CheckoutExecution, signal: AbortSignal): Promise<void>;
  run(execution: CheckoutExecution, signal: AbortSignal): Promise<void>;
  /**
   * Wait for all old effects and stop guards to finish or be retired. If any
   * effect is ambiguous, return no evidence and retain the resource in recovery.
   */
  drain(execution: CheckoutExecution): Promise<{ effectsFenced: true; finalState: string; receipt?: string } | undefined>;
}

/**
 * The adapter and policy come from trusted executor configuration. Registration,
 * instructions and possession of a grant alone cannot select either one.
 */
export async function executeResourceCheckout({
  authority, actor, token, adapter, policy, jobId, costMinorUnits, signal, onBound,
}: {
  authority: ResourceCheckoutAuthority;
  actor: CheckoutActor;
  token: CheckoutToken;
  adapter: CheckoutProviderAdapter;
  policy: CheckoutExecutionPolicy;
  jobId: string;
  costMinorUnits: number;
  signal: AbortSignal;
  onBound?: () => void;
}): Promise<"rejected" | "released" | "recovery_required"> {
  if (signal.aborted || !policy.allowedActors.includes(actor.key) || adapter.id !== policy.adapterId
    || !Number.isSafeInteger(policy.maxCostMinorUnits) || !policy.finalState
    || !Number.isSafeInteger(costMinorUnits) || costMinorUnits < 0 || costMinorUnits > policy.maxCostMinorUnits) return "rejected";
  const deadlineAt = authority.executionDeadline(actor, token);
  if (deadlineAt === undefined) return "rejected";
  const provider = { deadlineAt, maxCostMinorUnits: costMinorUnits, finalState: policy.finalState, adapterScope: adapter.scope };
  const execution: CheckoutExecution = { ...token, jobId, ...provider };
  if (adapter.accepts?.(execution) === false || !authority.bindJob(actor, token, { id: jobId, executor: adapter.id, provider })) return "rejected";
  onBound?.();
  const stop = new AbortController();
  const check = () => {
    try {
      if (!authority.jobMayRun(token, jobId)) stop.abort();
    } catch {
      stop.abort();
    }
  };
  const timer = setInterval(check, 1_000);
  timer.unref();
  const runSignal = AbortSignal.any([signal, stop.signal]);
  const work = async () => {
    runSignal.throwIfAborted();
    await adapter.prepare(execution, runSignal);
    runSignal.throwIfAborted();
    if (authority.activateJob(token, jobId)) await adapter.run(execution, runSignal);
  };
  let onAbort: () => void = () => {};
  try {
    check();
    if (!runSignal.aborted) {
      // Cancellation ends our wait. The approved controller still has to
      // fence outstanding operations, including a preparation RPC in flight.
      const cancelled = new Promise<void>((resolve) => {
        onAbort = resolve;
        runSignal.addEventListener("abort", onAbort, { once: true });
      });
      await Promise.race([work(), cancelled]);
    }
  } catch {
    // A rejected response can still have produced an effect. Drain this exact job.
  } finally {
    clearInterval(timer);
    runSignal.removeEventListener("abort", onAbort);
  }
  if (await drainExecution(authority, adapter, execution)) return "released";
  authority.markJobRecovery(token, jobId);
  return "recovery_required";
}

async function drainExecution(authority: ResourceCheckoutAuthority, adapter: CheckoutProviderAdapter, execution: CheckoutExecution): Promise<boolean> {
  try {
    if (authority.beginJobDrain(execution, execution.jobId)) {
      const evidence = await adapter.drain(execution);
      if (evidence?.effectsFenced && evidence.finalState === execution.finalState && authority.finishJob(execution, execution.jobId, evidence.receipt)) {
        return true;
      }
    }
  } catch {
    // Preserve ownership if the executor or authority is unavailable.
  }
  return false;
}

export async function recoverResourceCheckout({
  authority, actor, token, adapter,
}: {
  authority: ResourceCheckoutAuthority;
  actor: CheckoutActor;
  token: CheckoutToken;
  adapter: CheckoutProviderAdapter;
}): Promise<"rejected" | "released" | "recovery_required"> {
  const job = authority.providerJob(actor, token);
  if (!job?.provider || job.executor !== adapter.id || job.provider.adapterScope !== adapter.scope) return "rejected";
  const execution = { ...token, ...job.provider, jobId: job.id };
  return await drainExecution(authority, adapter, execution) ? "released" : "recovery_required";
}
