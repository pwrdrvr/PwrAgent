import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ThreadSandboxRecord,
  ThreadSandboxStore,
} from "../state/thread-sandbox-store";

/**
 * Releases the Sandboxer sandboxes a thread created, once every PR attached
 * to the thread has merged or closed.
 *
 * Sandboxer is driven only through its MCP tools, over the gateway's tool-call
 * path, so this works the same whether the connection is the local `sbx mcp`
 * process or a hosted endpoint. The capability comes from the connection's
 * tool list, not a version: `delete_sandbox` when listed, otherwise
 * `stop_sandbox`, which ends compute billing but keeps the snapshot. A
 * stopped sandbox stays pending, and a later cleanup deletes it once the
 * connection lists `delete_sandbox`.
 *
 * Only ids recorded from this thread's own `create_sandbox` results are ever
 * touched. "Not found" counts as already gone. Any other failure leaves the
 * sandbox in place, and it is reported, never thrown.
 */

export const SANDBOXER_DELETE_TOOL = "delete_sandbox";
export const SANDBOXER_STOP_TOOL = "stop_sandbox";
const CLEANUP_TIMEOUT_MS = 60_000;
const DETAIL_LIMIT = 200;

export type SandboxCleanupAction =
  | "deleted"
  | "stopped"
  | "already-gone"
  | "pending-delete"
  | "failed"
  | "skipped";

export type SandboxCleanupEntry = {
  sandboxId: string;
  name?: string;
  action: SandboxCleanupAction;
  detail?: string;
};

export type SandboxCleanupReport = {
  backend: string;
  threadId: string;
  entries: SandboxCleanupEntry[];
};

/** One gateway session for PwrAgent's own calls; closed after cleanup. */
export type SandboxerCleanupTransport = {
  listToolNames(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): void | Promise<void>;
};

export type SandboxerPrCleanupOptions = {
  store: Pick<ThreadSandboxStore, "pendingForThread" | "markOutcome">;
  openTransport: (params: {
    connectionId: string;
    backend: string;
    threadId: string;
    signal: AbortSignal;
  }) => Promise<SandboxerCleanupTransport>;
  /** The operator's switch in Settings → Plugins → MCPs. */
  isEnabled: () => boolean;
  onReport?: (report: SandboxCleanupReport) => void;
  now?: () => number;
  timeoutMs?: number;
};

export class SandboxerPrCleanupService {
  private readonly inFlight = new Map<string, Promise<SandboxCleanupReport>>();

  constructor(private readonly options: SandboxerPrCleanupOptions) {}

  /** Concurrent callers for one thread share one run. */
  async cleanupThread(params: {
    backend: string;
    threadId: string;
  }): Promise<SandboxCleanupReport> {
    const key = JSON.stringify([params.backend, params.threadId]);
    const running = this.inFlight.get(key);
    if (running) return await running;
    const run = this.run(params).finally(() => {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return await run;
  }

  private async run(params: {
    backend: string;
    threadId: string;
  }): Promise<SandboxCleanupReport> {
    const pending = this.options.store.pendingForThread(params);
    const report: SandboxCleanupReport = { ...params, entries: [] };
    if (pending.length === 0) return report;
    if (!this.options.isEnabled()) {
      report.entries = pending.map((record) => entry(record, "skipped",
        "Automatic cleanup is off in Settings → Plugins → MCPs; left in place."));
      this.options.onReport?.(report);
      return report;
    }
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? CLEANUP_TIMEOUT_MS);
    const byConnection = new Map<string, ThreadSandboxRecord[]>();
    for (const record of pending) {
      byConnection.set(record.connectionId, [
        ...(byConnection.get(record.connectionId) ?? []),
        record,
      ]);
    }
    for (const [connectionId, records] of byConnection) {
      report.entries.push(...await this.cleanupConnection({
        ...params,
        connectionId,
        records,
        signal,
      }));
    }
    this.options.onReport?.(report);
    return report;
  }

  private async cleanupConnection(params: {
    backend: string;
    threadId: string;
    connectionId: string;
    records: ThreadSandboxRecord[];
    signal: AbortSignal;
  }): Promise<SandboxCleanupEntry[]> {
    let transport: SandboxerCleanupTransport;
    let tools: string[];
    try {
      transport = await this.options.openTransport(params);
    } catch (error) {
      return params.records.map((record) => entry(record, "failed",
        `Sandboxer was unavailable (${describeError(error)}); left in place.`));
    }
    try {
      tools = await transport.listToolNames();
    } catch (error) {
      await closeQuietly(transport);
      return params.records.map((record) => entry(record, "failed",
        `Sandboxer's tools could not be listed (${describeError(error)}); left in place.`));
    }
    const canDelete = tools.includes(SANDBOXER_DELETE_TOOL);
    const canStop = tools.includes(SANDBOXER_STOP_TOOL);
    const entries: SandboxCleanupEntry[] = [];
    try {
      for (const record of params.records) {
        if (params.signal.aborted) {
          entries.push(entry(record, "failed", "Cleanup timed out; left in place."));
          continue;
        }
        if (canDelete) {
          entries.push(await this.release(transport, record, "delete"));
        } else if (record.status === "stopped") {
          entries.push(entry(record, "pending-delete",
            "Already stopped. Deletion is pending: Sandboxer's MCP has no delete_sandbox tool."));
        } else if (canStop) {
          entries.push(await this.release(transport, record, "stop"));
        } else {
          entries.push(entry(record, "failed",
            "Sandboxer lists neither delete_sandbox nor stop_sandbox; left in place."));
        }
      }
    } finally {
      await closeQuietly(transport);
    }
    return entries;
  }

  private async release(
    transport: SandboxerCleanupTransport,
    record: ThreadSandboxRecord,
    mode: "delete" | "stop",
  ): Promise<SandboxCleanupEntry> {
    let result: CallToolResult;
    try {
      result = await transport.callTool(
        mode === "delete" ? SANDBOXER_DELETE_TOOL : SANDBOXER_STOP_TOOL,
        { sandboxId: record.sandboxId },
      );
    } catch (error) {
      return entry(record, "failed", `${describeError(error)}; left in place.`);
    }
    const text = resultText(result);
    if (result.isError && !isNotFound(text) && !(mode === "stop" && isAlreadyStopped(text))) {
      return entry(record, "failed", `${truncate(text) || "Sandboxer reported an error"}; left in place.`);
    }
    const now = this.now();
    if (result.isError && isNotFound(text)) {
      this.options.store.markOutcome({
        connectionId: record.connectionId,
        sandboxId: record.sandboxId,
        status: "deleted",
        note: "Sandboxer reported it no longer exists.",
        now,
      });
      return entry(record, "already-gone", "Sandboxer reported it no longer exists.");
    }
    if (mode === "delete") {
      this.options.store.markOutcome({
        connectionId: record.connectionId,
        sandboxId: record.sandboxId,
        status: "deleted",
        now,
      });
      return entry(record, "deleted");
    }
    const note = "Stopped; compute billing ended and its snapshot remains. Deletion is pending: Sandboxer's MCP has no delete_sandbox tool.";
    this.options.store.markOutcome({
      connectionId: record.connectionId,
      sandboxId: record.sandboxId,
      status: "stopped",
      note,
      now,
    });
    return entry(record, "stopped", note);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function formatSandboxCleanupLines(
  report: SandboxCleanupReport | undefined,
): string[] {
  if (!report || report.entries.length === 0) return [];
  return [
    "",
    "Sandboxer cleanup by PwrAgent (sandboxes this thread created)",
    ...report.entries.map((item) =>
      `- ${item.sandboxId}${item.name ? ` (${item.name})` : ""}: ${
        ACTION_LABELS[item.action]
      }${item.detail ? `. ${item.detail}` : ""}`),
  ];
}

export function summarizeSandboxCleanup(report: SandboxCleanupReport): string {
  const counts = new Map<SandboxCleanupAction, number>();
  for (const item of report.entries) {
    counts.set(item.action, (counts.get(item.action) ?? 0) + 1);
  }
  return [...counts].map(([action, count]) =>
    `${ACTION_LABELS[action]} ${count}`).join(", ");
}

const ACTION_LABELS: Record<SandboxCleanupAction, string> = {
  deleted: "deleted",
  stopped: "stopped",
  "already-gone": "already deleted",
  "pending-delete": "stopped, deletion pending",
  failed: "not cleaned up",
  skipped: "skipped",
};

/**
 * The sandbox in a successful `create_sandbox` result. Sandboxer answers
 * with one JSON text block (`{"id":"sb_…","name":…}`); structured content is
 * read first in case it moves there. Anything else records nothing.
 */
export function readCreatedSandbox(
  result: CallToolResult,
): { sandboxId: string; name?: string } | undefined {
  if (result.isError) return undefined;
  const candidates: unknown[] = [result.structuredContent];
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try {
      candidates.push(JSON.parse(block.text));
    } catch {
      // Not JSON; ignore.
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const id = record.id ?? record.sandboxId;
    if (typeof id === "string" && SANDBOX_ID_PATTERN.test(id)) {
      return {
        sandboxId: id,
        ...(typeof record.name === "string" && record.name.trim()
          ? { name: record.name.trim().slice(0, 200) }
          : {}),
      };
    }
  }
  return undefined;
}

const SANDBOX_ID_PATTERN = /^sb_[A-Za-z0-9]{1,64}$/;

function entry(
  record: ThreadSandboxRecord,
  action: SandboxCleanupAction,
  detail?: string,
): SandboxCleanupEntry {
  return {
    sandboxId: record.sandboxId,
    ...(record.name ? { name: record.name } : {}),
    action,
    ...(detail ? { detail } : {}),
  };
}

function resultText(result: CallToolResult): string {
  return (result.content ?? [])
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join(" ")
    .trim();
}

function isNotFound(text: string): boolean {
  return /not[\s_-]?found|no such sandbox|does not exist|\b404\b/i.test(text);
}

function isAlreadyStopped(text: string): boolean {
  return /already (?:stopped|archived|archiving)/i.test(text);
}

function truncate(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

function describeError(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error));
}

async function closeQuietly(transport: SandboxerCleanupTransport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Closing a session never changes what happened to the sandboxes.
  }
}
