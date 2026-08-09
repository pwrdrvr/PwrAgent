import type { DesktopFederationMode } from "@pwragent/shared";
import { getMainLogger } from "./log";
import {
  getRuntimeLeaseManager,
  RuntimeLeaseManager,
  type RuntimeLeaseManagerOptions,
} from "./runtime-lease-manager";

/**
 * The slice of DesktopFederationRuntime the coordinator drives. Structural
 * (rather than importing the runtime class) so this module and
 * federation-runtime.ts stay acyclic for dependency-cruiser.
 */
export type FederationLeaseRuntime = {
  stop(): Promise<void>;
};

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

type RuntimeFederationLeaseCoordinatorOptions = RuntimeLeaseManagerOptions & {
  leaseManager?: RuntimeLeaseManager;
};

/**
 * Profile-scoped gate for the federation runtime, mirroring the messaging
 * lease coordinator. Two app instances sharing a profile present the same
 * federation instance identity, so without this lease they evict each other
 * from the gateway in a connect/replace loop; the lease makes exactly one of
 * them run federation for the profile at a time.
 */
export class RuntimeFederationLeaseCoordinator {
  private readonly leaseManager: RuntimeLeaseManager;
  private disabledReasonKind: RuntimeFederationDisabledReasonKind | undefined;

  constructor(options: RuntimeFederationLeaseCoordinatorOptions = {}) {
    this.leaseManager =
      options.leaseManager
      ?? (hasCustomLeaseManagerOptions(options)
        ? new RuntimeLeaseManager(options)
        : getRuntimeLeaseManager());
  }

  get id(): string {
    return this.leaseManager.id;
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
    _runtime: FederationLeaseRuntime,
    mode: DesktopFederationMode,
  ): Promise<RuntimeFederationLeaseApplyResult> {
    if (mode === "disabled") {
      this.leaseManager.release("federation");
      this.disabledReasonKind = "saved_disabled";
      return {
        enabled: false,
        disabledReasonKind: "saved_disabled",
        disabledReason: "Federation is disabled in saved settings.",
      };
    }

    const acquire = this.leaseManager.acquire("federation");
    if (!acquire.acquired) {
      this.disabledReasonKind = "lease_held";
      return {
        enabled: false,
        disabledReasonKind: "lease_held",
        disabledReason:
          "Federation is already active in another PwrAgent instance for this profile.",
        leaseHolder: acquire.holder,
      };
    }

    this.disabledReasonKind = undefined;
    return { enabled: true };
  }

  /**
   * Post-acquisition startup failure cleanup, mirroring the messaging
   * coordinator: tear down any partially started runtime and release the
   * lease so another instance can take over the profile.
   */
  async releaseAfterStartupFailure(
    runtime: FederationLeaseRuntime,
  ): Promise<void> {
    try {
      await runtime.stop();
    } catch (error) {
      leaseLog.warn("federation runtime stop failed during startup cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.leaseManager.release("federation");
      this.disabledReasonKind = "startup_error";
    }
  }

  shutdownSync(): void {
    this.leaseManager.release("federation");
  }

  snapshot(): RuntimeFederationLeaseSnapshot {
    const lease = this.leaseManager.snapshot("federation");
    return {
      instanceId: lease.instanceId,
      leaseHeld: lease.leaseHeld,
      ...(this.disabledReasonKind
        ? {
            disabledReasonKind: this.disabledReasonKind,
            disabledReason: federationDisabledReasonMessage(
              this.disabledReasonKind,
            ),
          }
        : {}),
      ...(lease.leaseHolder ? { leaseHolder: lease.leaseHolder } : {}),
    };
  }
}

function hasCustomLeaseManagerOptions(
  options: RuntimeFederationLeaseCoordinatorOptions,
): boolean {
  return Boolean(
    options.instanceId
    || options.profileName
    || options.processId
    || options.startedAt
    || options.cwd
    || options.now
    || options.store
    || options.processIsAlive
    || options.runtimeIdentityIsAlive,
  );
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
