import os from "node:os";
import {
  getProcessRuntimeIdentity,
  isProfileRuntimeIdentityLive,
  resolveActiveProfileName,
} from "./profile";
import { getAppRuntimeInstanceStore } from "./state/app-state";
import type {
  AppRuntimeInstanceRecord,
  AppRuntimeInstanceStore,
  AppRuntimeMessagingDisabledReason,
  MessagingRuntimeLeaseRecord,
} from "./state/app-runtime-instance-store";

export const PWRAGENT_INSTANCE_ROOT_ENV = "PWRAGENT_INSTANCE_ROOT";
const RUNTIME_BOOT_TIME_TOLERANCE_MS = 5_000;

export type RuntimeLeaseKind = "messaging" | "federation";

export type RuntimeLeaseHolder = {
  instanceId: string;
  processId?: number;
  cwdHint?: string;
  startedAt?: number;
};

export type RuntimeLeaseAcquireResult =
  | { acquired: true }
  | { acquired: false; holder: RuntimeLeaseHolder };

export type RuntimeLeaseSnapshot = {
  instanceId: string;
  leaseHeld: boolean;
  leaseHolder?: RuntimeLeaseHolder;
};

export type RuntimeLeaseManagerOptions = {
  instanceId?: string;
  profileName?: string;
  processId?: number;
  startedAt?: number;
  cwd?: string;
  now?: () => number;
  store?: AppRuntimeInstanceStore;
  env?: NodeJS.ProcessEnv;
  processIsAlive?: (processId: number) => boolean;
  runtimeIdentityIsAlive?: (owner: AppRuntimeInstanceRecord) => boolean;
  systemBootedAt?: number;
};

/**
 * One process-level owner for every profile-scoped runtime lease.
 *
 * Ownership is registered once in sqlite and remains valid while the owning
 * process has a fresh profile marker matching its PID, instance ID, and start
 * time. An owner from before the current OS boot is conclusively dead and can
 * be replaced immediately. Otherwise the first challenger that observes the
 * identity absent persists that fact; after a one-minute safety grace, a
 * challenger may replace the dead owner inside the store's atomic acquisition
 * transaction. This deliberately favors single-owner safety over taking work
 * away from a process that is alive but temporarily hung.
 */
export class RuntimeLeaseManager {
  private readonly instanceId: string;
  private readonly profileName: string;
  private readonly processId: number;
  private readonly startedAt: number;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly store: AppRuntimeInstanceStore;
  private readonly runtimeIdentityIsAlive: (
    owner: AppRuntimeInstanceRecord,
  ) => boolean;
  private readonly systemBootedAt: number;
  private readonly heldLeases = new Set<RuntimeLeaseKind>();
  private instanceRecorded = false;
  private instanceExited = false;

  constructor(options: RuntimeLeaseManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    const processIdentity = getProcessRuntimeIdentity();
    this.instanceId = options.instanceId ?? processIdentity.instanceId;
    this.profileName = options.profileName ?? resolveActiveProfileName();
    this.processId = options.processId ?? process.pid;
    this.startedAt =
      options.startedAt
      ?? (options.instanceId ? this.now() : processIdentity.startedAt);
    this.cwd =
      options.cwd
      ?? options.env?.[PWRAGENT_INSTANCE_ROOT_ENV]
      ?? process.env[PWRAGENT_INSTANCE_ROOT_ENV]
      ?? process.cwd();
    this.store = options.store ?? getAppRuntimeInstanceStore();
    this.systemBootedAt =
      options.systemBootedAt
      ?? this.now() - os.uptime() * 1_000;
    this.runtimeIdentityIsAlive =
      options.runtimeIdentityIsAlive
      ?? (options.processIsAlive
        ? (owner) => options.processIsAlive!(owner.processId)
        : (owner) =>
            isProfileRuntimeIdentityLive(
              owner.profileName,
              owner,
              {
                env: options.env,
                now: this.now(),
              },
            ));
  }

  get id(): string {
    return this.instanceId;
  }

  recordMessagingState(params: {
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled: boolean;
    disabledReason?: AppRuntimeMessagingDisabledReason;
  }): void {
    const now = this.now();
    if (!this.instanceRecorded) {
      this.store.recordInstanceStart({
        instanceId: this.instanceId,
        profileName: this.profileName,
        processId: this.processId,
        cwd: this.cwd,
        startedAt: this.startedAt,
        desiredMessagingEnabled: params.desiredMessagingEnabled,
        effectiveMessagingEnabled: params.effectiveMessagingEnabled,
        disabledReason: params.disabledReason,
      });
      this.instanceRecorded = true;
      return;
    }
    this.store.markDesiredMessaging({
      instanceId: this.instanceId,
      desiredMessagingEnabled: params.desiredMessagingEnabled,
      effectiveMessagingEnabled: params.effectiveMessagingEnabled,
      disabledReason: params.disabledReason,
      now,
    });
  }

  acquire(kind: RuntimeLeaseKind): RuntimeLeaseAcquireResult {
    this.ensureInstanceRecorded();
    const params = {
      instanceId: this.instanceId,
      isOwnerAlive: (owner: AppRuntimeInstanceRecord) =>
        this.isOwnerAlive(owner),
      canReclaimOwnerImmediately: (owner: AppRuntimeInstanceRecord) =>
        this.ownerPredatesCurrentBoot(owner),
      now: this.now(),
    };
    const result =
      kind === "messaging"
        ? this.store.acquireMessagingLease(params)
        : this.store.acquireFederationLease(params);
    if (result.acquired) {
      this.heldLeases.add(kind);
      return { acquired: true };
    }
    this.heldLeases.delete(kind);
    return {
      acquired: false,
      holder: this.describeLeaseHolder(result.holder),
    };
  }

  release(kind: RuntimeLeaseKind): boolean {
    const now = this.now();
    const released =
      kind === "messaging"
        ? this.store.releaseMessagingLease({
            instanceId: this.instanceId,
            now,
          })
        : this.store.releaseFederationLease({
            instanceId: this.instanceId,
            now,
          });
    this.heldLeases.delete(kind);
    return released;
  }

  snapshot(kind: RuntimeLeaseKind): RuntimeLeaseSnapshot {
    const lease = this.readLease(kind);
    const leaseHeld =
      lease?.status === "active"
      && lease.ownerInstanceId === this.instanceId
      && this.heldLeases.has(kind);
    if (!leaseHeld) {
      this.heldLeases.delete(kind);
    }
    const leaseHolder =
      lease
      && lease.status === "active"
      && lease.ownerInstanceId !== this.instanceId
        ? this.describeLeaseHolder(lease)
        : undefined;
    return {
      instanceId: this.instanceId,
      leaseHeld,
      ...(leaseHolder ? { leaseHolder } : {}),
    };
  }

  getInstance(): AppRuntimeInstanceRecord | undefined {
    return this.store.getInstance(this.instanceId);
  }

  markExited(): void {
    if (!this.instanceRecorded || this.instanceExited) {
      return;
    }
    this.instanceExited = true;
    this.store.markInstanceExited({
      instanceId: this.instanceId,
      now: this.now(),
    });
  }

  private ensureInstanceRecorded(): void {
    if (this.instanceRecorded) {
      return;
    }
    this.recordMessagingState({
      desiredMessagingEnabled: false,
      effectiveMessagingEnabled: false,
    });
  }

  private isOwnerAlive(owner: AppRuntimeInstanceRecord): boolean {
    if (owner.exitedAt !== undefined) {
      return false;
    }
    if (owner.processId === this.processId) {
      return owner.instanceId === this.instanceId;
    }
    return this.runtimeIdentityIsAlive(owner);
  }

  private ownerPredatesCurrentBoot(owner: AppRuntimeInstanceRecord): boolean {
    return owner.startedAt
      < this.systemBootedAt - RUNTIME_BOOT_TIME_TOLERANCE_MS;
  }

  private readLease(kind: RuntimeLeaseKind): MessagingRuntimeLeaseRecord | undefined {
    return kind === "messaging"
      ? this.store.getMessagingLease()
      : this.store.getFederationLease();
  }

  private describeLeaseHolder(
    lease: MessagingRuntimeLeaseRecord,
  ): RuntimeLeaseHolder {
    const holder = this.store.getInstance(lease.ownerInstanceId);
    return {
      instanceId: lease.ownerInstanceId,
      ...(holder?.processId ? { processId: holder.processId } : {}),
      ...(holder?.cwdHint ? { cwdHint: holder.cwdHint } : {}),
      ...(holder?.startedAt ? { startedAt: holder.startedAt } : {}),
    };
  }
}

let manager: RuntimeLeaseManager | null = null;

export function getRuntimeLeaseManager(): RuntimeLeaseManager {
  if (!manager) {
    manager = new RuntimeLeaseManager();
  }
  return manager;
}

export function getExistingRuntimeLeaseManager(): RuntimeLeaseManager | null {
  return manager;
}

export function setRuntimeLeaseManagerForTests(
  next: RuntimeLeaseManager | null,
): void {
  manager = next;
}
