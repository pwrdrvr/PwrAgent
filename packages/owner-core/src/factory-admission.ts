import { createHash, randomUUID } from "node:crypto";
import { FACTORY_BUILDER_ISOLATION, type DurableTurnReceipt, type GetDurableTurnRequest, type SubmitDurableTurnRequest } from "@pwragent/shared/contracts/durable-turn-requests";
import { isFederationInstanceId } from "@pwragent/shared/contracts/federation";
import { canonicalDurableTurnRequest } from "@pwragent/shared/durable-turn-request";
import { factoryWorkItemKey, parseFactoryWorkItem, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { FACTORY_CPU_HOLD_MS, type FactoryCpuStatus } from "./resource-checkout-authority";

const SAMPLE_MAX_AGE_MS = 30_000;
const LEGACY_DISPLAY_ID = /^[a-z][a-z0-9]*-[1-9][0-9]*$/i;
const KNOWN_REJECTIONS = new Set([
  "request_invalid", "request_expired", "request_hash_mismatch", "request_too_large",
  "request_destination_unavailable", "request_quota_exceeded",
]);

export type FactoryOwner = { instanceId: string; machineId: string };
export type FactoryAdmissionSubject = { projectKey: string } & (
  | { issueId: string; workItem?: Extract<FactoryWorkItem, { provider: "linear" }> }
  | { issueId?: never; workItem: Exclude<FactoryWorkItem, { provider: "linear" }> }
);
type Target = FactoryOwner & { threadId: string; worktreePath: string };
type Approval = FactoryAdmissionSubject & {
  repository: string;
  owner: FactoryOwner;
  target: Target;
  platform: "darwin" | "linux" | "win32";
  requiresE2eVm: boolean;
};
type Terminal = "completed" | "failed" | "cancelled" | "rejected";
type AdmissionState = {
  phase: "armed" | "leasing" | "dispatching" | "closing" | "terminal";
  paused?: boolean;
  cancelRequested?: boolean;
  resourceId?: string;
  outcome?: Terminal;
  queueEntryId?: string;
  turnId?: string;
};
export type FactoryAdmissionRow = Approval & AdmissionState & {
  id: string;
  revision: number;
  createdAt: number;
  payloadHash: string;
};

export interface FactoryAdmissionStore {
  read(subject: FactoryAdmissionSubject): FactoryAdmissionRow | undefined;
  /** Atomically check the duplicate subject and the single profile-wide slot. */
  insert(row: FactoryAdmissionRow): boolean;
  update(previous: FactoryAdmissionRow, next: FactoryAdmissionRow): void;
}

export interface FactoryAdmissionPorts {
  store: FactoryAdmissionStore;
  owner(): FactoryOwner | undefined;
  project(projectKey: string, repository: string): Promise<boolean>;
  probe(row: FactoryAdmissionRow): Promise<{
    machineId: string; platform: string; virtualMachine?: boolean; sampledAt: number;
  } | undefined>;
  resource(machineId: string): string | undefined;
  acquire(row: FactoryAdmissionRow): Promise<"granted" | "rejected" | "uncertain">;
  release(row: FactoryAdmissionRow): Promise<boolean>;
  capacity(row: FactoryAdmissionRow): Promise<FactoryCpuStatus | null>;
  submit(target: Target, request: SubmitDurableTurnRequest): Promise<DurableTurnReceipt>;
  receipt(target: Target, request: GetDurableTurnRequest): Promise<DurableTurnReceipt | null>;
  stop(target: Target, receipt: DurableTurnReceipt): Promise<void>;
  now?: () => number;
}

type Command =
  | ({ action: "arm"; brief: string } & Approval)
  | ({ action: "dispatch"; brief: string } & FactoryAdmissionSubject)
  | ({ action: "pause" | "resume" | "cancel" | "status" | "reconcile" } & FactoryAdmissionSubject);

export type FactoryAdmissionResult = {
  row: Omit<FactoryAdmissionRow, "payloadHash">;
  receipt?: Pick<DurableTurnReceipt, "state" | "queueEntryId" | "outcome"> & { turnId?: string };
  capacity?: FactoryCpuStatus | { state: "unverified" };
  blocker?: "paused" | "cancel_requested" | "arm_expired" | "project_unavailable" | "executor_unavailable"
    | "e2e_vm_unsupported" | "capacity_unavailable" | "checkout_uncertain" | "dispatch_uncertain";
};

export function factoryAdmissionSubject(projectKey: string, workItem: FactoryWorkItem): FactoryAdmissionSubject {
  return workItem.provider === "linear" ? { projectKey, workItem, issueId: workItem.id } : { projectKey, workItem };
}

export function factoryAdmissionKey(subject: FactoryAdmissionSubject): string {
  // Keep the existing SQLite subject and dispatch prompt for Linear approvals.
  return subject.issueId ?? factoryWorkItemKey(subject.workItem);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Factory command object.");
  return value as Record<string, unknown>;
}

function field(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error("Invalid Factory command field.");
  }
  return value.trim();
}

function machine(value: unknown): FactoryOwner {
  const { instanceId, machineId } = object(value);
  if (!isFederationInstanceId(instanceId) || typeof machineId !== "string"
      || !/^mach_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(machineId)) {
    throw new Error("Select a known Factory instance and machine.");
  }
  return { instanceId, machineId };
}

function readCommand(value: unknown): Command {
  const input = object(value);
  const { action } = input;
  const projectKey = field(input.projectKey, 4096);
  if (!projectKey.startsWith("directory:")) throw new Error("Select a registered Factory project.");
  // A prior approval may hold the profile slot under a display identifier.
  // Its original key and payload hash remain necessary to observe or stop it.
  const recovery = action === "status" || action === "reconcile" || action === "cancel" || action === "pause";
  const issueId = typeof input.issueId === "string" && input.issueId.length <= 80 ? input.issueId.trim() : input.issueId;
  const subject = recovery && input.workItem === undefined && typeof issueId === "string"
    && issueId.length <= 80 && LEGACY_DISPLAY_ID.test(issueId)
    ? { projectKey, issueId: issueId.toUpperCase() }
    : factoryAdmissionSubject(projectKey, parseFactoryWorkItem({ workItem: input.workItem, issueId }));
  if (action === "dispatch") return { action, ...subject, brief: field(input.brief, 8000) };
  if (action === "status" || action === "reconcile" || action === "pause" || action === "resume" || action === "cancel") {
    return { action, ...subject };
  }
  if (action !== "arm") throw new Error("Unknown Factory action.");
  const platform = input.platform;
  const repository = field(input.repository, 140).toLowerCase();
  if (!/^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/.test(repository) || (platform !== "darwin" && platform !== "linux" && platform !== "win32")
      || (input.requiresE2eVm !== undefined && typeof input.requiresE2eVm !== "boolean")) {
    throw new Error("Select a first-party repository and supported operating system.");
  }
  const target = object(input.target);
  const worktreePath = field(target.worktreePath, 4096);
  if (Array.from(worktreePath).some((character) => character.charCodeAt(0) < 32)) throw new Error("Invalid Factory worktree path.");
  return {
    action, ...subject, repository, platform, requiresE2eVm: input.requiresE2eVm === true,
    owner: machine(input.owner),
    target: { ...machine(target), threadId: field(target.threadId, 512), worktreePath },
    brief: field(input.brief, 8000),
  };
}

function sameOwner(left: FactoryOwner | undefined, right: FactoryOwner): boolean {
  return left?.instanceId === right.instanceId && left.machineId === right.machineId;
}

function requestFor(row: Approval & Pick<FactoryAdmissionRow, "id" | "createdAt">, brief: string): SubmitDurableTurnRequest {
  const request: SubmitDurableTurnRequest["request"] = {
    backend: "codex", threadId: row.target.threadId, delivery: "new_turn",
    // Capacity is requested after arming and always lasts this long. An
    // executor cannot queue the start beyond the reservation's deadline.
    boundedStart: { before: row.createdAt + FACTORY_CPU_HOLD_MS, worktreePath: row.target.worktreePath, repository: row.repository },
    factoryBuilderIsolation: FACTORY_BUILDER_ISOLATION,
    executionMode: "auto", sandbox: "workspace-write", approvalPolicy: "never",
    input: [{ type: "text", text: [
      `Factory outcome ${factoryAdmissionKey(row)} for ${row.repository}.`,
      `Work only in the operator-prepared checkout at ${row.target.worktreePath}.`,
      "Use this checkout to implement and verify the approved outcome. Keep all changes local. Do not push, publish, create a pull request, merge, provision infrastructure, or delegate.",
      "",
      brief,
    ].join("\n") }],
  };
  const key = { version: 1 as const, id: row.id, createdAt: row.createdAt };
  const payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(row.target.instanceId, { request, clientRequest: key })).digest("hex");
  return { request, clientRequest: { ...key, payloadHash } };
}

function result(row: FactoryAdmissionRow, blocker?: FactoryAdmissionResult["blocker"], receipt?: DurableTurnReceipt): FactoryAdmissionResult {
  const { payloadHash: _hash, ...visible } = row;
  const workItem = row.workItem ?? (row.issueId && !LEGACY_DISPLAY_ID.test(row.issueId) ? parseFactoryWorkItem(row) : undefined);
  return { row: { ...visible, ...(workItem ? { workItem } : {}) }, ...(blocker ? { blocker } : {}), ...(receipt ? {
    receipt: { state: receipt.state, outcome: receipt.outcome, queueEntryId: receipt.queueEntryId, turnId: receipt.result?.turnId },
  } : {}) };
}

export class FactoryAdmission {
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly ports: FactoryAdmissionPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** Called only by the local operator transports. A retry reads the exact same owner and request. */
  async command(value: unknown): Promise<FactoryAdmissionResult> {
    const command = readCommand(value);
    if (this.busy) throw new Error("A Factory command is in progress. Retry the same command.");
    this.busy = true;
    try {
      return await this.run(command);
    } finally {
      this.busy = false;
    }
  }

  private async run(command: Command): Promise<FactoryAdmissionResult> {
    const row = this.ports.store.read(command);
    if (command.action === "arm") return this.arm(command, row);
    if (!row) throw new Error("This Factory outcome is disarmed.");
    this.assertOwner(row.owner);
    if (command.action === "dispatch") {
      const request = requestFor(row, command.brief);
      if (request.clientRequest.payloadHash !== row.payloadHash) throw new Error("Factory approval payload changed.");
      return row.phase === "terminal" ? result(row) : this.dispatch(row, request);
    }
    if (row.phase === "terminal" || command.action === "status") return result(row);
    if (command.action === "cancel") {
      const cancelled = row.cancelRequested ? row : this.save(row, { cancelRequested: true });
      return this.reconcile(cancelled);
    }
    if (command.action === "pause" || command.action === "resume") {
      const paused = command.action === "pause";
      return result(Boolean(row.paused) === paused ? row : this.save(row, { paused }));
    }
    return this.reconcile(row);
  }

  private async arm(command: Extract<Command, { action: "arm" }>, row?: FactoryAdmissionRow): Promise<FactoryAdmissionResult> {
    const { action: _action, brief, ...approval } = command;
    this.assertOwner(approval.owner);
    if (row) {
      const original = {
        projectKey: row.projectKey, key: factoryAdmissionKey(row), repository: row.repository,
        platform: row.platform, requiresE2eVm: row.requiresE2eVm, owner: row.owner, target: row.target,
      };
      const requested = requestFor({ ...approval, id: row.id, createdAt: row.createdAt }, brief);
      if (JSON.stringify(original) !== JSON.stringify({
        projectKey: approval.projectKey, key: factoryAdmissionKey(approval), repository: approval.repository,
        platform: approval.platform, requiresE2eVm: approval.requiresE2eVm, owner: approval.owner, target: approval.target,
      }) || requested.clientRequest.payloadHash !== row.payloadHash) {
        throw new Error("This tracking record already has a different Factory approval.");
      }
      return result(row);
    }
    if (!await this.ports.project(approval.projectKey, approval.repository)) throw new Error("Factory project is unavailable.");
    this.assertOwner(approval.owner);
    const key = { id: randomUUID(), createdAt: this.now() };
    const { payloadHash } = requestFor({ ...approval, ...key }, brief).clientRequest;
    const armed: FactoryAdmissionRow = { ...approval, ...key, payloadHash, phase: "armed", revision: 1 };
    if (!this.ports.store.insert(armed)) throw new Error("The Factory pilot already has an active outcome.");
    return result(armed);
  }

  private async dispatch(row: FactoryAdmissionRow, request: SubmitDurableTurnRequest): Promise<FactoryAdmissionResult> {
    if (row.phase === "closing" || row.cancelRequested) return this.reconcile(row);
    const retry = row.phase === "dispatching";
    if (retry) {
      const receipt = await this.readReceipt(row);
      if (receipt && (!this.matches(row, receipt) || receipt.state !== "accepted" || receipt.result)) {
        return this.observe(row, receipt);
      }
      if (receipt === undefined) return result(row, "dispatch_uncertain");
    }
    if (row.paused) return result(row, "paused");
    if (this.expired(row)) return retry ? result(row, "dispatch_uncertain") : this.close(row, "rejected", "arm_expired");
    if (row.requiresE2eVm) return result(row, "e2e_vm_unsupported");
    if (!await this.ports.project(row.projectKey, row.repository)) return result(row, "project_unavailable");
    const sample = await this.ports.probe(row).catch(() => undefined);
    if (!sample || !Number.isSafeInteger(sample.sampledAt) || sample.machineId !== row.target.machineId || sample.platform !== row.platform || sample.virtualMachine !== false
        || this.now() - sample.sampledAt > SAMPLE_MAX_AGE_MS || sample.sampledAt > this.now()) {
      return result(row, "executor_unavailable");
    }

    const resourceId = this.ports.resource(sample.machineId);
    if (!resourceId || (row.resourceId !== undefined && row.resourceId !== resourceId)) return result(row, "capacity_unavailable");
    if (row.phase === "armed") row = this.save(row, { phase: "leasing", resourceId });
    this.assertOwner(row.owner);
    const grant = await this.ports.acquire(row);
    if (grant === "uncertain") return result(row, "checkout_uncertain");
    if (grant === "rejected") {
      return retry ? result(row, "dispatch_uncertain")
        : result(this.save(row, { phase: "terminal", outcome: "rejected" }), "capacity_unavailable");
    }
    if (this.expired(row) || this.now() - sample.sampledAt > SAMPLE_MAX_AGE_MS) {
      return retry ? result(row, "dispatch_uncertain") : this.close(row, "rejected", "executor_unavailable");
    }
    this.assertOwner(row.owner);
    if (!retry) row = this.save(row, { phase: "dispatching" });
    let receipt: DurableTurnReceipt;
    try {
      receipt = await this.ports.submit(row.target, request);
    } catch (error) {
      // Only a refusal before the receiver's durable acceptance can release the fence.
      if (!retry && error instanceof Error && "code" in error
          && typeof error.code === "string" && KNOWN_REJECTIONS.has(error.code)) {
        return this.close(row, "rejected");
      }
      return result(row, "dispatch_uncertain");
    }
    return this.observe(row, receipt);
  }

  private async readReceipt(row: FactoryAdmissionRow): Promise<DurableTurnReceipt | null | undefined> {
    try {
      return await this.ports.receipt(row.target, { id: row.id, backend: "codex", threadId: row.target.threadId });
    } catch {
      return undefined;
    }
  }

  private async reconcile(row: FactoryAdmissionRow): Promise<FactoryAdmissionResult> {
    if (row.phase === "closing") return this.release(row);
    if (row.phase !== "dispatching") {
      return row.cancelRequested ? this.close(row, "cancelled") : result(row);
    }
    const receipt = await this.readReceipt(row);
    if (!receipt || !this.matches(row, receipt)) return result(row, "dispatch_uncertain");
    if (receipt.state !== "completed" && row.cancelRequested) {
      this.assertOwner(row.owner);
      try {
        await this.ports.stop(row.target, receipt);
      } catch {
        return result(row, "dispatch_uncertain", receipt);
      }
      const updated = await this.readReceipt(row);
      return updated ? this.observe(row, updated) : result(row, "dispatch_uncertain");
    }
    return this.observe(row, receipt);
  }

  private matches(row: FactoryAdmissionRow, receipt: DurableTurnReceipt): boolean {
    return receipt.id === row.id && receipt.payloadHash === row.payloadHash
      && receipt.ownerInstanceId === row.target.instanceId && receipt.backend === "codex"
      && receipt.threadId === row.target.threadId;
  }

  private async observe(row: FactoryAdmissionRow, receipt: DurableTurnReceipt): Promise<FactoryAdmissionResult> {
    if (!this.matches(row, receipt)) return result(row, "dispatch_uncertain");
    if (receipt.state === "completed" && receipt.outcome) return this.close(row, receipt.outcome, undefined, receipt);
    const blocker = receipt.state === "uncertain" || receipt.state === "dispatching" ? "dispatch_uncertain"
      : row.cancelRequested ? "cancel_requested" : undefined;
    // CPU expiry ends a reservation, independently of the exact turn's
    // disposition. The worktree fence follows the durable receipt.
    const capacity = await this.ports.capacity(row).catch(() => null);
    return { ...result(row, blocker, receipt), capacity: capacity ?? { state: "unverified" } };
  }

  private close(row: FactoryAdmissionRow, outcome: Terminal, blocker?: FactoryAdmissionResult["blocker"], receipt?: DurableTurnReceipt): Promise<FactoryAdmissionResult> {
    return this.release(this.save(row, { phase: row.resourceId ? "closing" : "terminal", outcome,
      ...(receipt ? { queueEntryId: receipt.queueEntryId, turnId: receipt.result?.turnId } : {}),
    }), blocker, receipt);
  }

  private async release(row: FactoryAdmissionRow, blocker?: FactoryAdmissionResult["blocker"], receipt?: DurableTurnReceipt): Promise<FactoryAdmissionResult> {
    if (row.phase === "terminal") return result(row, blocker, receipt);
    this.assertOwner(row.owner);
    if (!await this.ports.release(row)) return result(row, "checkout_uncertain", receipt);
    return result(this.save(row, { phase: "terminal" }), blocker, receipt);
  }

  private expired(row: FactoryAdmissionRow): boolean {
    return this.now() >= row.createdAt + FACTORY_CPU_HOLD_MS;
  }

  private assertOwner(expected: FactoryOwner): void {
    if (!sameOwner(this.ports.owner(), expected)) throw new Error("Factory requires the selected local Federation owner.");
  }

  private save(row: FactoryAdmissionRow, change: Partial<AdmissionState>): FactoryAdmissionRow {
    this.assertOwner(row.owner);
    const next = { ...row, ...change, revision: row.revision + 1 };
    this.ports.store.update(row, next);
    return next;
  }
}
