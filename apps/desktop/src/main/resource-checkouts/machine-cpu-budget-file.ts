import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResourceDomain, ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";

export const MACHINE_CPU_BUDGETS_DIR_NAME = "machine-cpu-budgets";

export type MachineCpuBudgetGrantEntry = {
  allocationId: string;
  units: number;
  deadlineAt: number;
  backend: string;
  threadId: string;
  directories: string[];
};

export type MachineCpuBudgetSnapshot = {
  version: 1;
  instanceId: string;
  profile: string;
  capacity: number;
  updatedAt: number;
  grants: MachineCpuBudgetGrantEntry[];
};

export type MachineCpuBudgetPublisher = {
  sync(resource: ResourceDomain | undefined, observedAt: number): void;
  clear(): void;
};

function sanitizeProfileFileName(profile: string): string {
  const cleaned = profile.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "default";
}

export function machineCpuBudgetsDirectory(pwragentRoot: string): string {
  return path.join(pwragentRoot, "runtime", MACHINE_CPU_BUDGETS_DIR_NAME);
}

export function machineCpuBudgetFilePath(pwragentRoot: string, profile: string): string {
  return path.join(machineCpuBudgetsDirectory(pwragentRoot), `${sanitizeProfileFileName(profile)}.json`);
}

function normalizeDirectories(directories: readonly string[] | undefined): string[] {
  if (!directories || directories.length === 0) return [];
  const unique = new Set<string>();
  for (const entry of directories) {
    const trimmed = entry.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    unique.add(path.resolve(trimmed));
  }
  return [...unique].sort();
}

export function collectLocalMachineCpuBudgetGrants(
  resource: ResourceDomain | undefined,
  viewerInstanceId: string,
  localThreadDirectories?: (thread: Pick<ResourceThreadRef, "backend" | "threadId">) => readonly string[] | undefined,
): MachineCpuBudgetGrantEntry[] {
  if (!resource || resource.sharing.mode !== "counted") return [];
  const grants: MachineCpuBudgetGrantEntry[] = [];
  for (const allocation of resource.allocations) {
    if (allocation.state !== "granted" && allocation.state !== "active") continue;
    if (allocation.holder.kind !== "thread") continue;
    const { backend, threadId, instanceId } = allocation.holder.thread;
    if (instanceId !== undefined && instanceId !== viewerInstanceId) continue;
    const units = allocation.units;
    if (typeof units !== "number" || !Number.isInteger(units) || units < 1) continue;
    grants.push({
      allocationId: allocation.allocationId,
      units,
      deadlineAt: allocation.deadlineAt,
      backend,
      threadId,
      directories: normalizeDirectories(localThreadDirectories?.({ backend, threadId })),
    });
  }
  grants.sort((left, right) => left.allocationId.localeCompare(right.allocationId));
  return grants;
}

export function createMachineCpuBudgetPublisher(options: {
  pwragentRoot: string;
  profile: string;
  instanceId: string;
  localThreadDirectories?: (thread: Pick<ResourceThreadRef, "backend" | "threadId">) => readonly string[] | undefined;
  warn?: (error: unknown) => void;
}): MachineCpuBudgetPublisher {
  const directory = machineCpuBudgetsDirectory(options.pwragentRoot);
  const targetPath = machineCpuBudgetFilePath(options.pwragentRoot, options.profile);
  let lastFingerprint: string | undefined;

  const removeFile = (): void => {
    try {
      rmSync(targetPath, { force: true });
    } catch (error) {
      options.warn?.(error);
    }
  };

  return {
    sync(resource, observedAt) {
      const grants = collectLocalMachineCpuBudgetGrants(
        resource,
        options.instanceId,
        options.localThreadDirectories,
      );
      if (grants.length === 0) {
        if (lastFingerprint !== "") {
          removeFile();
          lastFingerprint = "";
        }
        return;
      }
      const capacity = Math.max(
        1,
        resource?.sharing.mode === "counted" ? resource.sharing.capacity : 1,
      );
      const fingerprint = JSON.stringify({ capacity, grants });
      if (fingerprint === lastFingerprint) return;
      const snapshot: MachineCpuBudgetSnapshot = {
        version: 1,
        instanceId: options.instanceId,
        profile: options.profile,
        capacity,
        updatedAt: observedAt,
        grants,
      };
      const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        renameSync(tempPath, targetPath);
        lastFingerprint = fingerprint;
      } catch (error) {
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // Best-effort cleanup of temp file.
        }
        options.warn?.(error);
      }
    },
    clear() {
      if (lastFingerprint === "") return;
      removeFile();
      lastFingerprint = "";
    },
  };
}
