import type {
  AppRuntimeMessagingDisabledReason,
} from "./state/app-runtime-instance-store";
import type {
  DesktopMessagingConfig,
} from "./messaging/messaging-config";
import {
  desktopMessagingConfigHasRunnableAdapters,
  type DesktopMessagingConfigLoadOptions,
} from "./messaging/messaging-config";
import type {
  DesktopMessagingConfigLoader,
  DesktopMessagingRuntime,
} from "./messaging/messaging-runtime";
import { resolveRuntimeMessagingOverride } from "./runtime-flags";
import { getMainLogger } from "./log";
import {
  getRuntimeLeaseManager,
  PWRAGENT_INSTANCE_ROOT_ENV,
  RuntimeLeaseManager,
  type RuntimeLeaseManagerOptions,
} from "./runtime-lease-manager";

export { PWRAGENT_INSTANCE_ROOT_ENV };

const leaseLog = getMainLogger("pwragent:messaging-lease");

export type RuntimeMessagingDisabledReasonKind =
  | AppRuntimeMessagingDisabledReason
  | "saved_disabled";

export type RuntimeMessagingLeaseSnapshot = {
  instanceId: string;
  disabledReasonKind?: RuntimeMessagingDisabledReasonKind;
  disabledReason?: string;
  effectiveMessagingEnabled: boolean;
  leaseHeld: boolean;
  leaseHolder?: {
    instanceId: string;
    processId?: number;
    cwdHint?: string;
    startedAt?: number;
  };
};

export type RuntimeMessagingLeaseApplyResult = {
  enabled: boolean;
  disabledReasonKind?: RuntimeMessagingDisabledReasonKind;
  disabledReason?: string;
  leaseHolder?: RuntimeMessagingLeaseSnapshot["leaseHolder"];
};

type RuntimeMessagingLeaseCoordinatorOptions = RuntimeLeaseManagerOptions & {
  leaseManager?: RuntimeLeaseManager;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

export class RuntimeMessagingLeaseCoordinator {
  private readonly leaseManager: RuntimeLeaseManager;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly argv?: readonly string[];

  constructor(options: RuntimeMessagingLeaseCoordinatorOptions = {}) {
    this.leaseManager =
      options.leaseManager
      ?? (hasCustomLeaseManagerOptions(options)
        ? new RuntimeLeaseManager(options)
        : getRuntimeLeaseManager());
    this.env = options.env;
    this.argv = options.argv;
  }

  get id(): string {
    return this.leaseManager.id;
  }

  async start(
    runtime: DesktopMessagingRuntime,
    loadConfig: DesktopMessagingConfigLoader,
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const override = resolveRuntimeMessagingOverride({
      env: this.env,
      argv: this.argv,
    });
    if (override.disabled) {
      this.recordStart({
        desiredMessagingEnabled: false,
        effectiveMessagingEnabled: false,
        disabledReason: "explicit_override",
      });
      return {
        enabled: false,
        disabledReasonKind: "explicit_override",
        ...(override.reason ? { disabledReason: override.reason } : {}),
      };
    }

    const config = await loadConfig({ logStartupEligibility: true });
    return this.applyResolvedConfig(runtime, config, { allowStart: true });
  }

  async applyLatestConfig(
    runtime: DesktopMessagingRuntime,
    loadConfig: DesktopMessagingConfigLoader,
    options: DesktopMessagingConfigLoadOptions & { allowStart?: boolean } = {},
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const config = await loadConfig({
      logStartupEligibility: options.logStartupEligibility,
      messagingEnabledOverride: options.messagingEnabledOverride,
    });
    return this.applyResolvedConfig(runtime, config, {
      allowStart: options.allowStart ?? true,
    });
  }

  async applyResolvedConfig(
    runtime: DesktopMessagingRuntime,
    config: DesktopMessagingConfig,
    options: { allowStart?: boolean } = {},
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    const desiredMessagingEnabled = config.enabled !== false;
    this.recordStart({
      desiredMessagingEnabled,
      effectiveMessagingEnabled: false,
      disabledReason: desiredMessagingEnabled ? undefined : "runtime_stopped",
    });

    if (config.enabled === false) {
      await this.stopRuntimeAndRelease(runtime, "runtime_stopped");
      return {
        enabled: false,
        disabledReasonKind: "saved_disabled",
        disabledReason: "Messaging is disabled in saved settings.",
      };
    }

    if (!desktopMessagingConfigHasRunnableAdapters(config)) {
      await this.stopRuntimeAndRelease(runtime, "no_runnable_adapters");
      return {
        enabled: false,
        disabledReasonKind: "no_runnable_adapters",
        disabledReason: "No messaging platforms are configured for this profile.",
      };
    }

    if (
      options.allowStart === false
      && !this.leaseManager.snapshot("messaging").leaseHeld
      && !runtime.isEnabled()
    ) {
      this.leaseManager.recordMessagingState({
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: false,
        disabledReason: "runtime_stopped",
      });
      return {
        enabled: false,
        disabledReasonKind: "runtime_stopped",
        disabledReason: "Messaging is stopped for this app instance.",
      };
    }

    const acquire = this.leaseManager.acquire("messaging");
    if (!acquire.acquired) {
      await runtime.stop();
      return {
        enabled: false,
        disabledReasonKind: "lease_held",
        disabledReason: "Messaging is already active in another PwrAgent instance for this profile.",
        leaseHolder: acquire.holder,
      };
    }

    try {
      await runtime.applyConfig(config, { allowStart: true });
    } catch (error) {
      await this.releaseAfterStartupFailure(runtime);
      throw error;
    }
    return { enabled: runtime.isEnabled() };
  }

  async disableForSession(
    runtime: DesktopMessagingRuntime,
  ): Promise<RuntimeMessagingLeaseApplyResult> {
    await this.stopRuntimeAndRelease(runtime, "runtime_stopped");
    return {
      enabled: false,
      disabledReasonKind: "runtime_stopped",
      disabledReason: "Messaging is stopped for this app instance.",
    };
  }

  async shutdown(runtime: DesktopMessagingRuntime): Promise<void> {
    await this.stopRuntimeAndRelease(runtime, "runtime_stopped");
  }

  shutdownSync(): void {
    this.leaseManager.release("messaging");
  }

  snapshot(): RuntimeMessagingLeaseSnapshot {
    const instance = this.leaseManager.getInstance();
    const lease = this.leaseManager.snapshot("messaging");
    return {
      instanceId: lease.instanceId,
      effectiveMessagingEnabled: instance?.effectiveMessagingEnabled ?? false,
      disabledReasonKind: instance?.disabledReason,
      ...(instance?.disabledReason
        ? { disabledReason: runtimeDisabledReasonMessage(instance.disabledReason) }
        : {}),
      leaseHeld: lease.leaseHeld,
      ...(lease.leaseHolder ? { leaseHolder: lease.leaseHolder } : {}),
    };
  }

  private recordStart(params: {
    desiredMessagingEnabled: boolean;
    effectiveMessagingEnabled: boolean;
    disabledReason?: AppRuntimeMessagingDisabledReason;
  }): void {
    this.leaseManager.recordMessagingState(params);
  }

  private async stopRuntimeAndRelease(
    runtime: DesktopMessagingRuntime,
    disabledReason: AppRuntimeMessagingDisabledReason,
  ): Promise<void> {
    await runtime.stop();
    this.leaseManager.release("messaging");
    this.leaseManager.recordMessagingState({
      desiredMessagingEnabled: disabledReason !== "runtime_stopped",
      effectiveMessagingEnabled: false,
      disabledReason,
    });
  }

  private async releaseAfterStartupFailure(
    runtime: DesktopMessagingRuntime,
  ): Promise<void> {
    try {
      await runtime.stop({ preserveStartupFailures: true });
    } catch (error) {
      leaseLog.warn("messaging runtime stop failed during startup cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.leaseManager.release("messaging");
      this.leaseManager.recordMessagingState({
        desiredMessagingEnabled: true,
        effectiveMessagingEnabled: false,
        disabledReason: "startup_error",
      });
    }
  }
}

function hasCustomLeaseManagerOptions(
  options: RuntimeMessagingLeaseCoordinatorOptions,
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

let coordinator: RuntimeMessagingLeaseCoordinator | null = null;

export function getRuntimeMessagingLeaseCoordinator(): RuntimeMessagingLeaseCoordinator {
  if (!coordinator) {
    coordinator = new RuntimeMessagingLeaseCoordinator();
  }
  return coordinator;
}

export function getExistingRuntimeMessagingLeaseCoordinator():
  | RuntimeMessagingLeaseCoordinator
  | null {
  return coordinator;
}

export function setRuntimeMessagingLeaseCoordinatorForTests(
  next: RuntimeMessagingLeaseCoordinator | null,
): void {
  coordinator = next;
}

function runtimeDisabledReasonMessage(
  reason: AppRuntimeMessagingDisabledReason,
): string {
  switch (reason) {
    case "explicit_override":
      return "Messaging is disabled for this app instance.";
    case "lease_held":
      return "Messaging is already active in another PwrAgent instance for this profile.";
    case "no_runnable_adapters":
      return "No messaging platforms are configured for this profile.";
    case "startup_error":
      return "Messaging failed during startup for this app instance.";
    case "runtime_stopped":
      return "Messaging is stopped for this app instance.";
  }
}
