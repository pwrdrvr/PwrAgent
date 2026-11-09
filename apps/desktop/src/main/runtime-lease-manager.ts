import os from "node:os";
import {
  RuntimeLeaseManager as OwnerRuntimeLeaseManager,
  type RuntimeLeaseManagerOptions as OwnerRuntimeLeaseManagerOptions,
} from "@pwragent/owner-core/runtime-lease-manager";
import {
  getProcessRuntimeIdentity,
  isProfileRuntimeIdentityLive,
  resolveActiveProfileName,
} from "./profile";
import { getDesktopRuntimeLeaseStorage } from "./storage/desktop-runtime-storage";

export type {
  RuntimeLeaseKind,
  RuntimeLeaseHolder,
  RuntimeLeaseAcquireResult,
  RuntimeLeaseSnapshot,
} from "@pwragent/owner-core/runtime-lease-manager";
export const PWRAGENT_INSTANCE_ROOT_ENV = "PWRAGENT_INSTANCE_ROOT";

export type RuntimeLeaseManagerOptions = Partial<OwnerRuntimeLeaseManagerOptions> & {
  env?: NodeJS.ProcessEnv;
  processIsAlive?: (processId: number) => boolean;
};

/** Desktop supplies the original profile, identity, storage and OS defaults. */
export class RuntimeLeaseManager extends OwnerRuntimeLeaseManager {
  constructor(options: RuntimeLeaseManagerOptions = {}) {
    const now = options.now ?? Date.now;
    const processIdentity = getProcessRuntimeIdentity();
    super({
      instanceId: options.instanceId ?? processIdentity.instanceId,
      profileName: options.profileName ?? resolveActiveProfileName(),
      processId: options.processId ?? process.pid,
      startedAt: options.startedAt ?? (options.instanceId ? now() : processIdentity.startedAt),
      cwd: options.cwd ?? options.env?.[PWRAGENT_INSTANCE_ROOT_ENV]
        ?? process.env[PWRAGENT_INSTANCE_ROOT_ENV] ?? process.cwd(),
      now,
      store: options.store ?? getDesktopRuntimeLeaseStorage(),
      systemBootedAt: options.systemBootedAt ?? now() - os.uptime() * 1_000,
      runtimeIdentityIsAlive: options.runtimeIdentityIsAlive
        ?? (options.processIsAlive
          ? owner => options.processIsAlive!(owner.processId)
          : owner => isProfileRuntimeIdentityLive(owner.profileName, owner, {
            env: options.env,
            now: now(),
          })),
    });
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
