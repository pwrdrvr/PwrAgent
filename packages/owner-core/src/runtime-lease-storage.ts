/** Persisted runtime identity and lease contracts; host liveness stays injected. */
export const RUNTIME_LEASE_DEAD_OWNER_GRACE_MS = 60_000;

export type AppRuntimeMessagingDisabledReason =
  | "explicit_override"
  | "lease_held"
  | "no_runnable_adapters"
  | "runtime_stopped"
  | "startup_error";

export type AppRuntimeInstanceRecord = {
  instanceId: string;
  profileName: string;
  processId: number;
  cwdHint?: string;
  cwdHash?: string;
  startedAt: number;
  heartbeatAt: number;
  exitedAt?: number;
  desiredMessagingEnabled: boolean;
  effectiveMessagingEnabled: boolean;
  disabledReason?: AppRuntimeMessagingDisabledReason;
};

export type MessagingRuntimeLeaseRecord = {
  ownerInstanceId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  releasedAt?: number;
  status: "active" | "released" | "expired";
};

export type MessagingLeaseAcquireResult =
  | { acquired: true; lease: MessagingRuntimeLeaseRecord }
  | { acquired: false; reason: "held"; holder: MessagingRuntimeLeaseRecord };

export type FederationRuntimeLeaseRecord = MessagingRuntimeLeaseRecord;
export type FederationLeaseAcquireResult = MessagingLeaseAcquireResult;
export type McpConnectionsRuntimeLeaseRecord = MessagingRuntimeLeaseRecord;
export type McpConnectionsLeaseAcquireResult = MessagingLeaseAcquireResult;

export type RuntimeLeaseAcquisition = {
  instanceId: string;
  isOwnerAlive?: (owner: AppRuntimeInstanceRecord) => boolean;
  canReclaimOwnerImmediately?: (owner: AppRuntimeInstanceRecord) => boolean;
  now: number;
};

/** Profile-bound storage. Acquisition and its side effects remain atomic. */
export interface RuntimeLeaseStorage {
  recordInstanceStart(params: {
    instanceId: string;
    profileName: string;
    processId: number;
    cwd?: string;
    cwdHash?: string;
    startedAt: number;
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled?: boolean;
    disabledReason?: string;
  }): AppRuntimeInstanceRecord;
  getInstance(instanceId: string): AppRuntimeInstanceRecord | undefined;
  markDesiredMessaging(params: {
    instanceId: string;
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled: boolean;
    disabledReason?: AppRuntimeMessagingDisabledReason;
    now: number;
  }): void;
  markInstanceExited(params: { instanceId: string; now: number }): void;
  acquireMessagingLease(params: RuntimeLeaseAcquisition): MessagingLeaseAcquireResult;
  acquireFederationLease(params: RuntimeLeaseAcquisition): FederationLeaseAcquireResult;
  acquireMcpConnectionsLease(params: Omit<RuntimeLeaseAcquisition, "canReclaimOwnerImmediately">): McpConnectionsLeaseAcquireResult;
  releaseMessagingLease(params: { instanceId: string; now: number }): boolean;
  releaseFederationLease(params: { instanceId: string; now: number }): boolean;
  releaseMcpConnectionsLease(params: { instanceId: string; now: number }): boolean;
  getMessagingLease(): MessagingRuntimeLeaseRecord | undefined;
  getFederationLease(): FederationRuntimeLeaseRecord | undefined;
  getMcpConnectionsLease(): McpConnectionsRuntimeLeaseRecord | undefined;
}
