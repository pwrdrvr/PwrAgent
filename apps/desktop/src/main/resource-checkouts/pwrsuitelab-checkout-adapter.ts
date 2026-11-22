import { createHash } from "node:crypto";
import type { CheckoutExecution, CheckoutExecutionPolicy, CheckoutProviderAdapter } from "@pwragent/owner-core/resource-checkout-executor";

export const PWR_SUITE_LAB_CHECKOUT_ADAPTER_ID = "pwrsuitelab-retained";
export const RETAINED_LAB_FINAL_STATE = "stopped-with-retained-assets";

type LabCommand = {
  execution: CheckoutExecution;
  target: string;
  workload: string;
  approval: string;
};

type LabPreparation = {
  execution: CheckoutExecution;
  independentGuardId: string;
  guardDeadlineAt: number;
  ready: boolean;
};

type LabDrain = {
  execution: CheckoutExecution;
  commandsSealed: boolean;
  inFlightCommands: number;
  ownedProcesses: number;
  stopGuardsRetired: boolean;
  artifactsCollected: boolean;
  compute: "stopped" | "running" | "unknown";
  retainedAssets: "verified" | "changed" | "unknown";
  receipt: string;
};

/**
 * A trusted host may supply this port only for an operator-approved
 * PwrSuiteLab controller. The controller owns the durable ledger, target
 * identity, spending guard and operation fencing. In particular, a delayed
 * prepare or run request may arrive after drain sealed its execution. The
 * controller must reject it at the effect boundary before mutating the target.
 */
export interface PwrSuiteLabCheckoutControl {
  prepare(command: LabCommand, signal: AbortSignal): Promise<LabPreparation>;
  run(command: LabCommand, signal: AbortSignal): Promise<void>;
  drain(command: LabCommand): Promise<LabDrain | undefined>;
}

export type ApprovedLabCheckout = {
  resourceId: string;
  target: string;
  workload: string;
  approval: string;
  expiresAt: number;
  maxDurationMs: number;
  policy: CheckoutExecutionPolicy;
  control: PwrSuiteLabCheckoutControl;
};

function matchesExecution(expected: CheckoutExecution, observed: CheckoutExecution): boolean {
  return expected.resourceId === observed.resourceId && expected.allocationId === observed.allocationId
    && expected.epoch === observed.epoch && expected.generation === observed.generation
    && expected.jobId === observed.jobId && expected.deadlineAt === observed.deadlineAt
    && expected.maxCostMinorUnits === observed.maxCostMinorUnits && expected.finalState === observed.finalState;
}

export function createPwrSuiteLabCheckoutAdapter(config: ApprovedLabCheckout, now: () => number): CheckoutProviderAdapter {
  const command = (execution: CheckoutExecution): LabCommand => ({
    execution, target: config.target, workload: config.workload, approval: config.approval,
  });
  const allowed = (execution: CheckoutExecution) => {
    const current = now();
    return Number.isSafeInteger(config.expiresAt) && Number.isSafeInteger(config.maxDurationMs)
      && config.maxDurationMs > 0 && execution.resourceId === config.resourceId && execution.deadlineAt > current
      && execution.deadlineAt <= config.expiresAt && execution.deadlineAt - current <= config.maxDurationMs
      && execution.maxCostMinorUnits <= config.policy.maxCostMinorUnits
      && execution.finalState === RETAINED_LAB_FINAL_STATE && !!config.approval && !!config.target && !!config.workload;
  };
  return {
    id: PWR_SUITE_LAB_CHECKOUT_ADAPTER_ID,
    scope: createHash("sha256").update(JSON.stringify([config.resourceId, config.target, config.workload, config.approval])).digest("hex"),
    accepts: allowed,
    async prepare(execution, signal) {
      signal.throwIfAborted();
      if (!allowed(execution)) throw new Error("The checkout exceeds the approved PwrSuiteLab policy.");
      const readiness = await config.control.prepare(command(execution), signal);
      if (!matchesExecution(execution, readiness.execution) || !readiness.ready || !readiness.independentGuardId
        || !Number.isSafeInteger(readiness.guardDeadlineAt) || readiness.guardDeadlineAt > execution.deadlineAt
        || readiness.guardDeadlineAt <= now()) throw new Error("The controller could not verify readiness and the independent stop guard.");
    },
    async run(execution, signal) {
      signal.throwIfAborted();
      if (!allowed(execution)) throw new Error("The approved PwrSuiteLab window ended.");
      await config.control.run(command(execution), signal);
    },
    async drain(execution) {
      const evidence = await config.control.drain(command(execution));
      if (!evidence || !matchesExecution(execution, evidence.execution) || !evidence.commandsSealed
        || evidence.inFlightCommands !== 0 || evidence.ownedProcesses !== 0 || !evidence.stopGuardsRetired
        || !evidence.artifactsCollected || evidence.compute !== "stopped" || evidence.retainedAssets !== "verified"
        || !evidence.receipt || evidence.receipt.length > 160) return undefined;
      return { effectsFenced: true, finalState: RETAINED_LAB_FINAL_STATE, receipt: evidence.receipt };
    },
  };
}
