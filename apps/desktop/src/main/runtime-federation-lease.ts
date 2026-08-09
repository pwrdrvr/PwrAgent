import type { DesktopFederationMode } from "@pwragent/shared";
import { getAppRuntimeInstanceStore } from "./state/app-state";
import type {
  AppRuntimeInstanceStore,
  FederationRuntimeLeaseRecord,
} from "./state/app-runtime-instance-store";
import { getRuntimeMessagingLeaseCoordinator } from "./runtime-messaging-lease";
import { getMainLogger } from "./log";

/**
 * The slice of DesktopFederationRuntime the coordinator drives. Structural
 * (rather than importing the runtime class) so this module and
 * federation-runtime.ts stay acyclic for dependency-cruiser.
 */
export type FederationLeaseRuntime = {
  stop(): Promise<void>;
};

export const FEDERATION_LEASE_TTL_MS = 30_000;
export const FEDERATION_LEASE_HEARTBEAT_MS = 10_000;

const leaseLog = getMainLogger("pwragent:federation-lease");

export type RuntimeFederationDisabledReasonKind =
  | "saved_disabled"
  | "lease_held"
  | "runtime_stopped"
  | "startup_error";

export type RuntimeFederationLeaseHolder = {
  instanceId: string;
  processId?: number;
  cwdHint?: string;
  startedAt?: number;
  expiresAt: number;
};

export type RuntimeFederationLeaseSnapshot = {
  instanceId: string;
  leaseHeld: boolean;
  disabledReasonKind?: RuntimeFederationDisabledReasonKind;
  disabledReason?: string;
  leaseHolder?: RuntimeFederationLeaseHolder;
};

export type RuntimeFederationLeaseApplyResult = {
  enabled: boolean;
  disabledReasonKind?: RuntimeFederationDisabledReasonKind;
  disabledReason?: string;
  leaseHolder?: RuntimeFederationLeaseHolder;
};

type RuntimeFederationLeaseCoordinatorOptions = {
  instanceId?: string;
  now?: () => number;
  store?: AppRuntimeInstanceStore;
};

/**
 * Profile-scoped gate for the federation runtime, mirroring the messaging
 * lease coordinator. Two app instances sharing a profile present the same
 * federation instance identity, so without this lease they evict each other
 * from the gateway in a connect/replace loop; the lease makes exactly one of
 * them run federation for the profile at a time.
 */
export class RuntimeFederationLeaseCoordinator {
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly store: AppRuntimeInstanceStore;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private leaseHeld = false;
  private disabledReasonKind: RuntimeFederationDisabledReasonKind | undefined;

  constructor(options: RuntimeFederationLeaseCoordinatorOptions = {}) {
    // Share the messaging lease's owner identity so one app process owns one
    // app_runtime_instances row and lease-holder lookups resolve to that
    // row's pid/cwd hint regardless of which lease is being described.
    this.instanceId =
      options.instanceId ?? getRuntimeMessagingLeaseCoordinator().id;
    this.now = options.now ?? Date.now;
    this.store = options.store ?? getAppRuntimeInstanceStore();
  }

  get id(): string {
    return this.instanceId;
  }

  /**
   * Decision ladder for one federation runtime (re)start, called from
   * DesktopFederationRuntime.restartNow after the previous runtime has been
   * torn down. An enabled mode must hold the profile federation lease before
   * any socket is opened; a live holder elsewhere keeps this instance
   * stopped. Unlike messaging there is no session override or runnable-
   * adapter gate: the federation mode is the whole ladder.
   */
  async applyMode(
    runtime: FederationLeaseRuntime,
    mode: DesktopFederationMode,
  ): Promise<RuntimeFederationLeaseApplyResult> {
    const now = this.now();
    if (mode === "disabled") {
      this.stopHeartbeat();
      if (this.leaseHeld) {
        this.store.releaseFederationLease({ instanceId: this.instanceId, now });
      }
      this.leaseHeld = false;
      this.disabledReasonKind = "saved_disabled";
      return {
        enabled: false,
        disabledReasonKind: "saved_disabled",
        disabledReason: "Federation is disabled in saved settings.",
      };
    }

    const acquire = this.store.acquireFederationLease({
      instanceId: this.instanceId,
      now,
      ttlMs: FEDERATION_LEASE_TTL_MS,
    });
    if (!acquire.acquired) {
      this.stopHeartbeat();
      this.leaseHeld = false;
      this.disabledReasonKind = "lease_held";
      const leaseHolder = this.describeLeaseHolder(acquire.holder);
      return {
        enabled: false,
        disabledReasonKind: "lease_held",
        disabledReason:
          "Federation is already active in another PwrAgent instance for this profile.",
        ...(leaseHolder ? { leaseHolder } : {}),
      };
    }

    this.leaseHeld = true;
    this.disabledReasonKind = undefined;
    this.startHeartbeat(runtime);
    return { enabled: true };
  }

  /**
   * Post-acquisition startup failure cleanup, mirroring the messaging
   * coordinator: stop the heartbeat, tear down any partially started
   * runtime, and release the lease so another instance can take over the
   * profile instead of this process renewing it with no runtime behind it.
   */
  async releaseAfterStartupFailure(
    runtime: FederationLeaseRuntime,
  ): Promise<void> {
    const now = this.now();
    this.stopHeartbeat();
    try {
      await runtime.stop();
    } catch (error) {
      leaseLog.warn("federation runtime stop failed during startup cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.leaseHeld) {
        this.store.releaseFederationLease({ instanceId: this.instanceId, now });
      }
      this.leaseHeld = false;
      this.disabledReasonKind = "startup_error";
    }
  }

  shutdownSync(): void {
    const now = this.now();
    this.stopHeartbeat();
    if (this.leaseHeld) {
      this.store.releaseFederationLease({ instanceId: this.instanceId, now });
    }
    this.leaseHeld = false;
  }

  snapshot(): RuntimeFederationLeaseSnapshot {
    const lease = this.store.getFederationLease();
    const leaseHolder =
      lease
      && lease.status === "active"
      && lease.ownerInstanceId !== this.instanceId
      && lease.expiresAt > this.now()
        ? this.describeLeaseHolder(lease)
        : undefined;
    return {
      instanceId: this.instanceId,
      leaseHeld: this.leaseHeld,
      ...(this.disabledReasonKind
        ? {
            disabledReasonKind: this.disabledReasonKind,
            disabledReason: federationDisabledReasonMessage(
              this.disabledReasonKind,
            ),
          }
        : {}),
      ...(leaseHolder ? { leaseHolder } : {}),
    };
  }

  private startHeartbeat(runtime: FederationLeaseRuntime): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      // Heartbeat must never throw out of the timer callback. A closed
      // state DB during process/test teardown would otherwise surface as an
      // unhandled exception after every assertion already passed.
      let renewed = false;
      try {
        renewed = this.store.renewFederationLease({
          instanceId: this.instanceId,
          now: this.now(),
          ttlMs: FEDERATION_LEASE_TTL_MS,
        });
      } catch (error) {
        this.stopHeartbeat();
        leaseLog.warn("federation lease heartbeat failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!renewed) {
        void this.stopRuntimeAfterLeaseLoss(runtime).catch((error) => {
          leaseLog.error("federation runtime stop failed after lease loss", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }, FEDERATION_LEASE_HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private async stopRuntimeAfterLeaseLoss(
    runtime: FederationLeaseRuntime,
  ): Promise<void> {
    const now = this.now();
    this.stopHeartbeat();
    this.leaseHeld = false;
    try {
      await runtime.stop();
    } finally {
      const lease = this.store.getFederationLease();
      this.disabledReasonKind =
        lease
        && lease.status === "active"
        && lease.ownerInstanceId !== this.instanceId
        && lease.expiresAt > now
          ? "lease_held"
          : "runtime_stopped";
    }
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private describeLeaseHolder(
    lease: FederationRuntimeLeaseRecord,
  ): RuntimeFederationLeaseHolder {
    const holder = this.store.getInstance(lease.ownerInstanceId);
    return {
      instanceId: lease.ownerInstanceId,
      ...(holder?.processId ? { processId: holder.processId } : {}),
      ...(holder?.cwdHint ? { cwdHint: holder.cwdHint } : {}),
      ...(holder?.startedAt ? { startedAt: holder.startedAt } : {}),
      expiresAt: lease.expiresAt,
    };
  }
}

let coordinator: RuntimeFederationLeaseCoordinator | null = null;

export function getRuntimeFederationLeaseCoordinator(): RuntimeFederationLeaseCoordinator {
  if (!coordinator) {
    coordinator = new RuntimeFederationLeaseCoordinator();
  }
  return coordinator;
}

export function getExistingRuntimeFederationLeaseCoordinator():
  | RuntimeFederationLeaseCoordinator
  | null {
  return coordinator;
}

export function setRuntimeFederationLeaseCoordinatorForTests(
  next: RuntimeFederationLeaseCoordinator | null,
): void {
  coordinator = next;
}

function federationDisabledReasonMessage(
  reason: RuntimeFederationDisabledReasonKind,
): string {
  switch (reason) {
    case "saved_disabled":
      return "Federation is disabled in saved settings.";
    case "lease_held":
      return "Federation is already active in another PwrAgent instance for this profile.";
    case "runtime_stopped":
      return "Federation is stopped for this app instance.";
    case "startup_error":
      return "Federation failed during startup for this app instance.";
  }
}
