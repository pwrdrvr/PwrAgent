import type { AppServerBackendKind } from "@pwragent/shared";

export type ThreadSandboxStatus = "active" | "stopped";

export type ThreadSandboxRecord = {
  connectionId: string;
  sandboxId: string;
  backend?: string;
  threadId: string;
  name?: string;
  status: ThreadSandboxStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
};

/** Pending resources observed from a thread's own successful MCP calls. */
export interface ThreadSandboxStorage {
  /** The first creator owns an id; duplicate observations never move it. */
  recordCreated(params: {
    connectionId: string;
    sandboxId: string;
    backend?: string;
    threadId: string;
    name?: string;
    now: number;
  }): boolean;
  pendingForThread(params: { backend: string; threadId: string }): ThreadSandboxRecord[];
  threadIdsWithPending(): string[];
  /** A stale outcome must not recreate a resource that was already deleted. */
  markOutcome(params: {
    connectionId: string;
    sandboxId: string;
    status: "stopped" | "deleted";
    note?: string;
    now: number;
  }): void;
  all(): ThreadSandboxRecord[];
}

/** Thread-selected MCP connections, resolved from the current owner metadata. */
export interface ThreadMcpConnectionSelectionStorage {
  readSelection(context: { backend: AppServerBackendKind; threadId: string }): Promise<string[]>;
}
