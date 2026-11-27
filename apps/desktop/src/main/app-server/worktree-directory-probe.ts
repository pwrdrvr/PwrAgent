import { stat } from "node:fs/promises";
import path from "node:path";

type DirectoryStatus = "available" | "missing" | "not-directory" | "unavailable";
type ProbeResult = DirectoryStatus | "not-responding" | "busy";
type PendingProbe = { result: Promise<ProbeResult>; waiting: boolean };

const PROBE_TIMEOUT_MS = 3_000;
// Leave capacity in libuv's default pool for work unrelated to these probes.
const MAX_RUNNING_PROBES = 2;

async function beforeTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const timeout = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => timeout.resolve(undefined), timeoutMs);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export function createWorktreeDirectoryProbe(
  statDirectory: (target: string) => Promise<{ isDirectory(): boolean }> = (target) => stat(target),
  timeoutMs = PROBE_TIMEOUT_MS,
): (target: string) => Promise<ProbeResult> {
  const running = new Map<string, PendingProbe>();

  return async (target) => {
    const key = path.normalize(target);
    const deadline = performance.now() + timeoutMs;
    let remaining = timeoutMs;
    for (;;) {
      const existing = running.get(key);
      if (existing) {
        return remaining === timeoutMs ? await existing.result
          : await beforeTimeout(existing.result, remaining) ?? "not-responding";
      }
      if (running.size < MAX_RUNNING_PROBES) break;
      const waiting = [...running.values()].filter((probe) => probe.waiting);
      if (remaining <= 0 || !waiting.length) return "busy";
      const settled = await beforeTimeout(Promise.race(waiting.map((probe) => probe.result)), remaining);
      remaining = deadline - performance.now();
      if (settled === undefined || remaining <= 0) return "busy";
    }

    const physical = Promise.resolve().then(async (): Promise<DirectoryStatus> => {
      try {
        return (await statDirectory(target)).isDirectory() ? "available" : "not-directory";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") return "missing";
        if (code === "ENOTDIR") return "not-directory";
        return "unavailable";
      }
    }).finally(() => {
      running.delete(key);
    });
    // A timeout releases callers. Only completion of the physical stat
    // releases its slot. Retries share the same settled answer until then.
    const result = beforeTimeout(physical, remaining).then((status): ProbeResult => {
      probe.waiting = false;
      return status ?? "not-responding";
    });
    const probe = { result, waiting: true };
    running.set(key, probe);
    return await result;
  };
}

export const checkWorktreeDirectory = createWorktreeDirectoryProbe();
