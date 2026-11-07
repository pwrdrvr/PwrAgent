import { randomUUID } from "node:crypto";
import type { ThreadMaintenanceRules, ThreadMaintenanceScan } from "@pwragent/shared";

/**
 * The longest a thread maintenance tool call waits before it answers.
 *
 * A full scan read 594 active and 2,352 archived threads in about two
 * minutes on one machine, and the archived-checkout audit grows with every
 * archived thread, so a call never waits for the scan to finish. It reports
 * the scan as running instead. The agent-tool MCP server now keeps a long
 * call open (see AGENT_TOOL_MCP_PROGRESS_INTERVAL_MS), but MCP clients other
 * than Claude Code may still give up on a call that takes minutes.
 */
export const THREAD_MAINTENANCE_TOOL_WAIT_MS = 40_000;

/** Failed scans remembered for the agent's next read. */
const FAILED_SCANS_KEPT = 8;

export type ThreadMaintenanceToolScanRequest = {
  rules?: Partial<ThreadMaintenanceRules>;
  projectKey?: string;
};

export type ThreadMaintenanceToolScanOutcome =
  | { kind: "finished"; scan: ThreadMaintenanceScan }
  | { kind: "running"; scanId: string; startedAt: number; projectKey?: string }
  | { kind: "failed"; scanId: string; message: string }
  | { kind: "missing" };

type RunningScan = {
  scanId: string;
  key: string;
  startedAt: number;
  projectKey?: string;
  done: Promise<ThreadMaintenanceScan>;
};

/**
 * Scans started by the agent tool. A scan keeps running in PwrAgent after the
 * call that started it answers; a later call reads it by its scanId. A scan
 * with the same request as one already running joins it, so a retry never
 * starts a second read of every thread.
 */
export class ThreadMaintenanceToolScans {
  private readonly running = new Map<string, RunningScan>();
  private readonly failed = new Map<string, string>();

  constructor(private readonly deps: {
    /** Runs a scan that will be retained under `scanId`. */
    scan: (request: ThreadMaintenanceToolScanRequest & { scanId: string }) => Promise<ThreadMaintenanceScan>;
    getScan: (scanId: string) => ThreadMaintenanceScan | undefined;
    now?: () => number;
    newId?: () => string;
  }) {}

  /** Starts a scan, or joins the running one with the same request, and
   * waits up to `waitMs` for it. */
  async start(request: ThreadMaintenanceToolScanRequest, waitMs: number): Promise<ThreadMaintenanceToolScanOutcome> {
    const key = requestKey(request);
    const running = [...this.running.values()].find((item) => item.key === key) ?? this.begin(request, key);
    return await this.wait(running, waitMs);
  }

  /** The scan with this id: waits up to `waitMs` while it runs. */
  async read(scanId: string, waitMs: number): Promise<ThreadMaintenanceToolScanOutcome> {
    const running = this.running.get(scanId);
    if (running) return await this.wait(running, waitMs);
    const message = this.failed.get(scanId);
    if (message !== undefined) return { kind: "failed", scanId, message };
    const scan = this.deps.getScan(scanId);
    return scan ? { kind: "finished", scan } : { kind: "missing" };
  }

  private begin(request: ThreadMaintenanceToolScanRequest, key: string): RunningScan {
    const scanId = this.deps.newId?.() ?? randomUUID();
    const running: RunningScan = {
      scanId, key, startedAt: this.deps.now?.() ?? Date.now(),
      ...(request.projectKey ? { projectKey: request.projectKey } : {}),
      done: Promise.resolve().then(async () => await this.deps.scan({ ...request, scanId })),
    };
    this.running.set(scanId, running);
    running.done.then(() => {
      this.running.delete(scanId);
    }, (error: unknown) => {
      this.running.delete(scanId);
      this.failed.set(scanId, error instanceof Error ? error.message : String(error));
      while (this.failed.size > FAILED_SCANS_KEPT) this.failed.delete(this.failed.keys().next().value!);
    });
    return running;
  }

  private async wait(running: RunningScan, waitMs: number): Promise<ThreadMaintenanceToolScanOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, waitMs)); });
    try {
      const scan = await Promise.race([running.done, timeout]);
      if (scan) return { kind: "finished", scan };
      return { kind: "running", scanId: running.scanId, startedAt: running.startedAt,
        ...(running.projectKey ? { projectKey: running.projectKey } : {}) };
    } catch (error) {
      return { kind: "failed", scanId: running.scanId, message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Requests that read the same state share one key. */
function requestKey(request: ThreadMaintenanceToolScanRequest): string {
  const rules = request.rules ?? {};
  return JSON.stringify([
    request.projectKey ?? null,
    rules.mode ?? null,
    rules.keepPerProject ?? null,
    rules.inactivityDays ?? null,
    rules.rebuildableOutputIsClean ?? null,
  ]);
}
