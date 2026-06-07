/**
 * Live IPC driver for the smoke eval. Drives the REAL app through the same
 * preload bridge (`window.pwragent.*`) the renderer uses — no mocked
 * app-server, no fragile DOM selectors. Every method is a thin `page.evaluate`
 * wrapper around a verified IPC verb (see eval/README.md for the shape map).
 *
 * The driver also runs an in-page event pump: it installs ONE `onAgentEvent`
 * listener that buffers notifications into `window.__evalEvents`, which the
 * Node side drains to detect turn completion and auto-respond to approval
 * requests. Approval payloads are built with the shipping
 * `buildPendingRequestResponse` so the decision shape never drifts from the UI.
 */
import type { Page } from "@playwright/test";
import {
  buildPendingRequestResponse,
  type AppServerPendingRequestNotification,
} from "@pwragent/shared";

/** A backend kind as the app reports it: "codex" | "grok" | `acp:${id}`. */
export type BackendKind = string;
export type ExecutionMode = "default" | "full-access";

export type AgentNotification = {
  method: string;
  params: {
    threadId?: string;
    turnId?: string | null;
    requestId?: string;
    [key: string]: unknown;
  };
};
export type AgentEvent = { backend: BackendKind; notification: AgentNotification };

export type BackendSummary = {
  kind: BackendKind;
  label: string;
  available: boolean;
  capabilities?: { createThread?: boolean };
  executionModes?: Array<{ mode: ExecutionMode; available: boolean }>;
  unavailableReason?: string;
};

/** Outcome of waiting for a single turn to settle. */
export type TurnOutcome = {
  status: "completed" | "failed" | "timeout";
  /** Final assistant text (from readThread.replay), trimmed. */
  answer: string;
  /** How many permission/approval requests we observed (and auto-approved). */
  approvals: number;
  /** Error text when status === "failed". */
  error?: string;
  /** Raw notification methods seen during the turn, for diagnostics. */
  methods: string[];
};

const EVENT_PUMP = `
  if (!window.__evalPumpInstalled && window.pwragent && window.pwragent.onAgentEvent) {
    window.__evalPumpInstalled = true;
    window.__evalEvents = [];
    window.pwragent.onAgentEvent(function (e) {
      try { window.__evalEvents.push(e); } catch (_) {}
    });
  }
  return Boolean(window.__evalPumpInstalled);
`;

export class LiveDriver {
  constructor(private readonly page: Page) {}

  /** Resolve once the preload bridge is exposed and the event pump is armed. */
  async waitReady(timeoutMs = 60_000): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      const ready = await this.page
        .evaluate("(function(){ return Boolean(window.pwragent); })()")
        .catch(() => false);
      if (ready) break;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("window.pwragent never appeared (renderer not ready)");
      }
      await this.page.waitForTimeout(250);
    }
    // Arm the event pump (idempotent).
    await this.page.evaluate(`(function(){ ${EVENT_PUMP} })()`);
  }

  private call<T>(method: string, arg?: unknown): Promise<T> {
    // Stringified so we don't ship a closure (avoids bundling quirks under tsx).
    return this.page.evaluate(
      `(function(a){ return window.pwragent.${method}(a); })(${JSON.stringify(
        arg ?? null,
      )})`,
    ) as unknown as Promise<T>;
  }

  listBackends(): Promise<{ backends: BackendSummary[] }> {
    return this.call("listBackends", { includeUnavailable: true });
  }

  refreshAcpAgents(): Promise<unknown> {
    return this.call("listAcpAgents", { refresh: true });
  }

  /** Thread ids currently known for a backend — used to discover the id of a
   *  thread just created through the UI (diff before/after clicking Start). */
  async listThreadIds(backend: BackendKind): Promise<string[]> {
    const res = await this.call<{ threads?: Array<{ id: string }> }>(
      "listThreads",
      { backend },
    );
    return (res.threads ?? []).map((t) => t.id);
  }

  registerDirectory(
    path: string,
    preferredBackend?: BackendKind,
  ): Promise<
    | { ok: true; directoryPath: string; directoryKey: string; directoryLabel: string }
    | { ok: false; reason: string; message: string }
  > {
    return this.call("registerDirectoryFromDisk", {
      path,
      ...(preferredBackend ? { preferredBackend } : {}),
    });
  }

  async startThread(
    backend: BackendKind,
    cwd: string,
    executionMode: ExecutionMode,
  ): Promise<string> {
    const res = await this.call<{ threadId: string }>("startThread", {
      backend,
      cwd,
      executionMode,
    });
    return res.threadId;
  }

  setExecutionMode(
    backend: BackendKind,
    threadId: string,
    executionMode: ExecutionMode,
  ): Promise<unknown> {
    return this.call("setThreadExecutionMode", {
      backend,
      threadId,
      executionMode,
    });
  }

  async startTurn(
    backend: BackendKind,
    threadId: string,
    text: string,
    executionMode: ExecutionMode,
  ): Promise<string> {
    const res = await this.call<{ turnId: string }>("startTurn", {
      backend,
      threadId,
      input: [{ type: "text", text }],
      executionMode,
    });
    return res.turnId;
  }

  readThread(
    backend: BackendKind,
    threadId: string,
  ): Promise<{
    threadStatus?: string;
    replay?: { lastAssistantMessage?: string };
  }> {
    return this.call("readThread", { backend, threadId });
  }

  private submitApproval(
    backend: BackendKind,
    notification: AppServerPendingRequestNotification,
  ): Promise<unknown> {
    const response = buildPendingRequestResponse(notification, "approve");
    const turnId =
      typeof notification.params.turnId === "string"
        ? notification.params.turnId
        : undefined;
    return this.call("submitServerRequest", {
      backend,
      threadId: notification.params.threadId,
      ...(turnId ? { turnId } : {}),
      requestId: notification.params.requestId,
      response,
    });
  }

  /** Drain + return the buffered agent events since the last drain. */
  private drainEvents(): Promise<AgentEvent[]> {
    return this.page.evaluate(
      "(function(){ var e = window.__evalEvents || []; window.__evalEvents = []; return e; })()",
    ) as unknown as Promise<AgentEvent[]>;
  }

  /**
   * Wait for a turn to settle: success, failure, or timeout. While waiting,
   * auto-approve every permission request (so build/test commands proceed) and
   * record how many we saw. Completion is detected from BOTH the event stream
   * (`turn/completed` | `turn/failed` for this turnId) and `readThread`
   * (`threadStatus === "idle"`), whichever lands first.
   */
  async waitForTurn(
    backend: BackendKind,
    threadId: string,
    // turnId is accepted for symmetry but completion is matched by threadId
    // (UI-created threads don't hand back a turnId).
    _turnId: string | undefined,
    opts: { timeoutMs: number; pollMs?: number; onLog?: (m: string) => void } = {
      timeoutMs: 180_000,
    },
  ): Promise<TurnOutcome> {
    const pollMs = opts.pollMs ?? 750;
    const startedAt = Date.now();
    let approvals = 0;
    let error: string | undefined;
    let completedByEvent = false;
    let sawActivity = false;
    const methods: string[] = [];

    const finalAnswer = async (): Promise<string> => {
      const view = await this.readThread(backend, threadId).catch(() => ({}));
      return (
        (view as { replay?: { lastAssistantMessage?: string } }).replay
          ?.lastAssistantMessage ?? ""
      ).trim();
    };

    for (;;) {
      const events = await this.drainEvents().catch(() => [] as AgentEvent[]);
      for (const ev of events) {
        const method = ev.notification?.method ?? "";
        const evThreadId = ev.notification?.params?.threadId;
        if (evThreadId !== threadId) continue;
        methods.push(method);
        if (method !== "turn/completed" && method !== "turn/failed") {
          sawActivity = true;
        }

        // Auto-approve permission requests so commands can run in Default
        // Access. `buildPendingRequestResponse` picks the right "approve"
        // decision token for commandExecution / fileChange / generic requests.
        if (method.includes("requestApproval")) {
          approvals += 1;
          opts.onLog?.(`  ↳ approval requested (${method}); auto-approving`);
          await this.submitApproval(
            backend,
            ev.notification as AppServerPendingRequestNotification,
          ).catch((e) => opts.onLog?.(`  ↳ approve failed: ${String(e)}`));
        }

        if (method === "turn/completed") {
          completedByEvent = true;
        }
        if (method === "turn/failed") {
          const turn = (
            ev.notification.params as { turn?: { error?: { message?: string } } }
          ).turn;
          error = turn?.error?.message ?? "turn failed";
        }
      }

      if (error) {
        return {
          status: "failed",
          answer: await finalAnswer(),
          approvals,
          error,
          methods,
        };
      }
      if (completedByEvent) {
        return { status: "completed", answer: await finalAnswer(), approvals, methods };
      }

      // Fallback: the completed event can be missed under load. If we've seen
      // the turn do *something* and the thread has gone idle, treat it as done.
      if (sawActivity) {
        const view = await this.readThread(backend, threadId).catch(() => ({}));
        if ((view as { threadStatus?: string }).threadStatus === "idle") {
          return {
            status: "completed",
            answer: await finalAnswer(),
            approvals,
            methods,
          };
        }
      }

      if (Date.now() - startedAt > opts.timeoutMs) {
        return { status: "timeout", answer: await finalAnswer(), approvals, methods };
      }
      await this.page.waitForTimeout(pollMs);
    }
  }
}
