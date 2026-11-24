import type {
  ResourceAllocationState,
  ResourceCheckoutActionResult,
  ResourceHolder,
  ResourceInstructionsRef,
  ResourceQueueOrder,
} from "@pwragent/shared/contracts/resource-checkouts";

export type CheckoutActor = {
  key: string;
  holder: ResourceHolder;
  manage: boolean;
};

export type CheckoutDefinition = {
  resourceId: string;
  canonicalKey: string;
  displayName: string;
  kindLabel: string;
  scope: "machine" | "instance" | "federation";
  capacity: number;
  counted: boolean;
  authorityId: string;
  epoch: number;
  maxHoldMs: number;
  revision: number;
  updatedAt: number;
  publication: "published" | "pending_registration";
  /** Absent: counted resources backfill and exclusive ones are `fifo` (`effectiveQueueOrder`). */
  queueOrder?: ResourceQueueOrder;
  draftOwnerInstanceId?: string;
  instructions?: ResourceInstructionsRef;
};

export type CheckoutWaiter = {
  id: string;
  actor: CheckoutActor;
  purpose: string;
  units: number;
  durationMs: number;
  requestedAt: number;
};

export type CheckoutGrant = CheckoutWaiter & {
  generation: number;
  grantedAt: number;
  deadlineAt: number;
  renewals: number;
  state: ResourceAllocationState;
  /** Backfilled capacity must expire without managed-job recovery. */
  backfilled?: true;
  executor?: CheckoutActor;
  job?: {
    id: string;
    executor: string;
    machineBootId?: string;
    processGroupId?: number;
    retainGrant?: boolean;
    provider?: { deadlineAt: number; maxCostMinorUnits: number; finalState: string; adapterScope?: string };
  };
  recoverySince?: number;
  fencingVerifiedAt?: number;
};

export type CheckoutDomainRecord = {
  definition: CheckoutDefinition;
  generation: number;
  grants: CheckoutGrant[];
  queue: CheckoutWaiter[];
  cleanupVerifiedAt?: number;
  cleanupReceipt?: string;
};

export type CheckoutReceipt = {
  resourceId: string;
  fingerprint: string;
  result: ResourceCheckoutActionResult;
};

export interface CheckoutTransaction {
  read(resourceId: string): CheckoutDomainRecord | undefined;
  list(): CheckoutDomainRecord[];
  save(record: CheckoutDomainRecord): void;
  receipt(actor: string, key: string): CheckoutReceipt | undefined;
  recordReceipt(actor: string, key: string, receipt: CheckoutReceipt): void;
}

export interface CheckoutStore {
  change<T>(apply: (tx: CheckoutTransaction) => T): T;
  readAll(): CheckoutDomainRecord[];
  receipt(actor: string, key: string): CheckoutReceipt | undefined;
}
