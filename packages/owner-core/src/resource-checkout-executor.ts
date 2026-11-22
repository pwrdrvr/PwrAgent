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
  maxCostMinorUnits: number;
  finalState: string;
};

export interface CheckoutProviderAdapter {
  id: string;
  /** Implementations keep effects scoped to this execution, even after cancellation. */
  prepare(execution: CheckoutExecution, signal: AbortSignal): Promise<void>;
  run(execution: CheckoutExecution, signal: AbortSignal): Promise<void>;
  /**
   * Wait for all old effects and stop guards to finish or be retired. If any
   * effect is ambiguous, return no evidence and retain the resource in recovery.
   */
  drain(execution: CheckoutExecution): Promise<{ effectsFenced: true; finalState: string } | undefined>;
}

/**
 * The adapter and policy come from trusted executor configuration. Registration,
 * instructions and possession of a grant alone cannot select either one.
 */
export async function executeResourceCheckout({
  authority, actor, token, adapter, policy, jobId, costMinorUnits, signal,
}: {
  authority: ResourceCheckoutAuthority;
  actor: CheckoutActor;
  token: CheckoutToken;
  adapter: CheckoutProviderAdapter;
  policy: CheckoutExecutionPolicy;
  jobId: string;
  costMinorUnits: number;
  signal: AbortSignal;
}): Promise<"rejected" | "released" | "recovery_required"> {
  if (signal.aborted || !policy.allowedActors.includes(actor.key) || adapter.id !== policy.adapterId
    || !Number.isSafeInteger(policy.maxCostMinorUnits) || !policy.finalState
    || !Number.isSafeInteger(costMinorUnits) || costMinorUnits < 0 || costMinorUnits > policy.maxCostMinorUnits) return "rejected";
  if (!authority.bindJob(actor, token, { id: jobId, executor: adapter.id })) return "rejected";
  const execution: CheckoutExecution = { ...token, jobId, maxCostMinorUnits: costMinorUnits, finalState: policy.finalState };
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
  try {
    check();
    if (!runSignal.aborted) {
      await adapter.prepare(execution, runSignal);
      if (!runSignal.aborted && authority.activateJob(token, jobId)) await adapter.run(execution, runSignal);
    }
  } catch {
    // A rejected response can still have produced an effect. Drain this exact job.
  } finally {
    clearInterval(timer);
  }
  try {
    if (authority.beginJobDrain(token, jobId)) {
      const evidence = await adapter.drain(execution);
      if (evidence?.effectsFenced && evidence.finalState === policy.finalState && authority.finishJob(token, jobId)) {
        return "released";
      }
    }
  } catch {
    // Preserve ownership if the executor or authority is unavailable.
  }
  authority.markJobRecovery(token, jobId);
  return "recovery_required";
}
