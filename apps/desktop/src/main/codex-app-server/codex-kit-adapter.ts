/**
 * KIT-BACKED Codex client (Phase B swap, v1, behind `PWRAGENT_CODEX_KIT=1`).
 *
 * Implements the registry's `BackendClient` surface but drives the kit's
 * `CodexThreadClient` (@pwrdrvr/agent-client) instead of PwrAgent's in-tree
 * `CodexAppServerClient`. The kit emits neutral `NormalizedThreadEvent`s; this
 * adapter maps them to the `AppServerNotification` shapes the registry + renderer
 * already consume, and accumulates a per-thread `NormalizedThread` (via the B1
 * reducer) so `readThread` can return a transcript.
 *
 * SCOPE (v1 — runnable core path): start thread, start turn, stream the
 * assistant message + tool activity, complete the turn, read the transcript,
 * interrupt. The rich Codex features (steering, compaction, review, model/skill/
 * account queries, environments) are intentionally NOT implemented here — they're
 * declared optional on `BackendClient`, so omitting them makes them simply
 * unavailable under the flag. The default (flag-off) path keeps the full in-tree
 * client untouched. This is the first thing you can launch and actually run on
 * the kit; the feature port + full swap follow.
 */
import {
  CodexThreadClient,
  type Unsubscribe,
} from "@pwrdrvr/agent-client";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import type { UserInput } from "@pwrdrvr/codex-app-server-protocol/v2";
import type {
  AppServerNotification,
  AppServerThreadSummary,
  AppServerTurnInputItem,
} from "@pwragent/shared";
import { reduceNormalizedThread } from "../acp/normalized-thread-reducer";
import { normalizedThreadToReplay } from "../acp/normalized-thread-to-replay";

export const CODEX_KIT_FLAG_ENV = "PWRAGENT_CODEX_KIT";

export function isCodexKitFlagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CODEX_KIT_FLAG_ENV]?.trim() === "1";
}

type NotificationListener = (
  notification: AppServerNotification,
) => void | Promise<void>;

export type CodexKitBackendClientOptions = {
  command?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
};

/**
 * Adapter satisfying the registry's `BackendClient` surface (the optional rich
 * methods are deliberately omitted in v1). Only the core methods are typed
 * structurally — the registry consumes this through the `BackendClient` type.
 */
export class CodexKitBackendClient {
  private readonly client: CodexThreadClient;
  private readonly listeners = new Set<NotificationListener>();
  /** Per-thread accumulated kit events, replayed through the reducer on read. */
  private readonly eventsByThread = new Map<string, NormalizedThreadEvent[]>();
  private unsubscribe: Unsubscribe | undefined;

  constructor(options: CodexKitBackendClientOptions = {}) {
    this.client = new CodexThreadClient({
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      clientName: "pwragent",
      clientVersion: options.clientVersion ?? "0.0.0",
    });
    this.unsubscribe = this.client.onEvent((event) => {
      void this.handleEvent(event);
    });
  }

  // ── BackendClient: event subscription ────────────────────────────────────
  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── BackendClient: lifecycle ─────────────────────────────────────────────
  async getInitializeResult(): Promise<Record<string, unknown>> {
    // Minimal: the kit handles initialize internally on first use. The registry
    // only needs this to not throw so Codex reports available under the flag.
    return {};
  }

  async listThreads(): Promise<AppServerThreadSummary[]> {
    // v1 doesn't surface the historical thread list through the kit; new threads
    // created in-session still render live. (Full list = a later increment.)
    return [];
  }

  async listSkills(): Promise<unknown[]> {
    return [];
  }

  async readThread(params: {
    threadId: string;
  }): Promise<ReturnType<typeof normalizedThreadToReplay>> {
    const events = this.eventsByThread.get(params.threadId) ?? [];
    return normalizedThreadToReplay(reduceNormalizedThread(events, params.threadId));
  }

  // ── BackendClient: thread + turn ─────────────────────────────────────────
  async startThread(params: {
    cwd?: string;
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    const result = await this.client.startThread({
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
    });
    this.eventsByThread.set(result.threadId, []);
    return { threadId: result.threadId };
  }

  async startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string; turnId: string }> {
    const text = params.input
      .map((item) => (item.type === "text" ? item.text : ""))
      .join("");
    const turn = await this.client.startTurn({
      threadId: params.threadId,
      input: { text },
      ...(params.reasoningEffort !== undefined
        ? { reasoning: params.reasoningEffort }
        : {}),
    });
    return { threadId: params.threadId, turnId: turn.turnId };
  }

  async interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    await this.client.interruptTurn(params.threadId);
    return params;
  }

  // ── BackendClient: rich Codex features (ported into the kit) ──────────────
  /** Inject input into the in-flight turn (kit `turn/steer`). */
  async steerTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }> {
    return this.client.steerTurn({
      threadId: params.threadId,
      input: params.input.map(toKitUserInput),
      expectedTurnId: params.expectedTurnId,
    });
  }

  /** Summarize thread history (kit `thread/compact/start`). */
  async compactThread(params: {
    threadId: string;
  }): Promise<{ threadId: string; turnId: string; itemId?: string }> {
    return this.client.compactThread(params.threadId);
  }

  /** Start a code review (kit `review/start`). */
  async startReview(params: {
    threadId: string;
    target: unknown;
    delivery?: unknown;
    cwd?: string;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    return this.client.startReview({
      threadId: params.threadId,
      target: params.target as Parameters<CodexThreadClient["startReview"]>[0]["target"],
      ...(params.delivery !== undefined
        ? {
            delivery: params.delivery as Parameters<
              CodexThreadClient["startReview"]
            >[0]["delivery"],
          }
        : {}),
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    });
  }

  /** Re-apply per-thread permissions via resume overlay (kit `thread/resume`). */
  async setThreadPermissions(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
  }): Promise<{ threadId: string }> {
    return this.client.setThreadPermissions({
      threadId: params.threadId,
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.approvalPolicy !== undefined
        ? { approvalPolicy: params.approvalPolicy }
        : {}),
      ...(params.sandbox !== undefined ? { sandbox: params.sandbox } : {}),
      ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
      ...(params.reasoningEffort !== undefined
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
    });
  }

  /** Mark a project directory trusted (kit `config/value/write`). */
  async trustProject(params: {
    projectPath: string;
    configPath?: string;
  }): Promise<{ projectPath: string; configPath?: string }> {
    return this.client.trustProject({
      projectPath: params.projectPath,
      ...(params.configPath !== undefined ? { configPath: params.configPath } : {}),
    });
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
    await this.client.close();
  }

  // ── kit event → AppServerNotification mapping ────────────────────────────
  private async handleEvent(event: NormalizedThreadEvent): Promise<void> {
    const threadId = "threadId" in event ? (event.threadId as string) : undefined;
    if (threadId) {
      const bucket = this.eventsByThread.get(threadId) ?? [];
      bucket.push(event);
      this.eventsByThread.set(threadId, bucket);
    }
    for (const notification of codexEventToNotifications(event)) {
      await this.fanout(notification);
    }
  }

  private async fanout(notification: AppServerNotification): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(notification);
      } catch {
        // a single renderer listener failing must not break the stream
      }
    }
  }
}

/**
 * Pure mapping: one neutral kit `NormalizedThreadEvent` → zero+
 * `AppServerNotification`s in the shapes the registry + renderer consume live.
 * Exported standalone so it's unit-testable without spawning Codex.
 */
export function codexEventToNotifications(
  event: NormalizedThreadEvent,
): AppServerNotification[] {
  switch (event.kind) {
    case "turn_started":
      return [
        {
          method: "turn/started",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            turn: { id: event.turnId, status: "inProgress" },
          },
        } as AppServerNotification,
      ];
    case "agent_message_delta":
      return [
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            delta: event.delta,
          },
        } as AppServerNotification,
      ];
    case "agent_message":
      return [
        {
          method: "item/completed",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            item: {
              id: event.message.id,
              type: "agentMessage",
              text: event.message.text,
            },
          },
        } as AppServerNotification,
      ];
    case "tool_call":
      return [
        {
          method: "item/started",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            item: { id: event.toolCall.id, type: codexItemType(event.toolCall.kind) },
          },
        } as AppServerNotification,
      ];
    case "tool_call_update":
      return [
        {
          method: "item/completed",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            item: {
              id: event.toolCall.id,
              type: codexItemType(event.toolCall.kind ?? "command"),
            },
          },
        } as AppServerNotification,
      ];
    case "token_usage":
      return [
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            tokenUsage: event.usage,
          },
        } as AppServerNotification,
      ];
    case "turn_completed":
      return [
        {
          method: "turn/completed",
          params: {
            threadId: event.threadId,
            turnId: event.turnId,
            turn: { id: event.turnId, status: "completed", output: [] },
          },
        } as AppServerNotification,
        // The kit's neutral event stream has no thread-status event, so Codex's
        // `thread/status/changed` notifications are dropped at the kit boundary.
        // The registry relies on a non-"active" status to sweep its synthetic
        // `pending:<threadId>` turn/started placeholder out of `activeTurnKeys`
        // (the thread-list "thinking" driver) — without this, that placeholder
        // leaks and the list stays stuck "thinking" while the transcript (which
        // reads threadStatus=idle) does not. Synthesize idle at turn end.
        idleStatusNotification(event.threadId),
      ];
    case "error":
      return [
        {
          method: "turn/failed",
          params: {
            threadId: event.threadId ?? "",
            turnId: event.turnId ?? "",
            turn: {
              id: event.turnId ?? "",
              status: "failed",
              error: { message: event.message },
            },
          },
        } as AppServerNotification,
        ...(event.threadId !== undefined
          ? [idleStatusNotification(event.threadId)]
          : []),
      ];
    default:
      return [];
  }
}

function codexItemType(kind: string): string {
  return kind === "command" ? "commandExecution" : "fileChange";
}

/**
 * A `thread/status/changed` → idle notification. Emitted at turn end so the
 * registry sweeps its synthetic `pending:<threadId>` placeholder from
 * `activeTurnKeys` (the wholesale sweep only fires for a non-"active" status).
 */
function idleStatusNotification(threadId: string): AppServerNotification {
  return {
    method: "thread/status/changed",
    params: { threadId, status: { type: "idle" } },
  } as AppServerNotification;
}

/** Map a PwrAgent turn-input item onto the kit's Codex `UserInput` shape. */
function toKitUserInput(item: AppServerTurnInputItem): UserInput {
  if (item.type === "text") {
    return { type: "text", text: item.text, text_elements: [] };
  }
  return item as unknown as UserInput;
}
