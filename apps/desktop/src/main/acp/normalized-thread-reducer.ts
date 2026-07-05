/**
 * Folds the kit normalizer's `NormalizedThreadEvent` stream
 * (`@pwrdrvr/agent-acp`'s `AcpSessionNormalizer.apply()`) into a coalesced
 * `NormalizedThread` — the accumulation step agent-core leaves to the consumer
 * (it ships `createEmptyThread` + `mergeToolCall` primitives but no reducer).
 *
 * This is a Phase B artifact: the renderer/store needs exactly this fold to turn
 * the kit's delta events into a thread view. For B1 (KTD-P3) it lets us compare
 * the kit pipeline against PwrAgent's in-tree `AcpSessionReplayNormalizer`
 * (which already returns a coalesced snapshot) — see
 * `normalized-thread-to-replay.ts` for the adapter to the legacy
 * `AppServerThreadReplay` shape and the parity test that asserts they agree.
 *
 * Scope note (B1 increment 1): messages (assistant text via deltas + finalized
 * `agent_message`), tool-call activities (merged), plans, and turn/thread
 * status. Reasoning deltas follow the agent's `surfaceThoughts` quirk. Token
 * usage / approvals / settings events are intentionally not part of the
 * transcript view and are ignored here.
 */
import {
  createEmptyThread,
  mergeToolCall,
  type NormalizedActivityEntry,
  type NormalizedMessage,
  type NormalizedMessageEntry,
  type NormalizedPlan,
  type NormalizedPlanEntry,
  type NormalizedThread,
  type NormalizedThreadActivity,
  type NormalizedThreadEntry,
  type NormalizedThreadEvent,
  type NormalizedToolCall,
  type NormalizedToolCallUpdate,
} from "@pwrdrvr/agent-core";

export function reduceNormalizedThread(
  events: readonly NormalizedThreadEvent[],
  threadId = "thread",
): NormalizedThread {
  const reducer = new NormalizedThreadReducer(threadId);
  for (const event of events) {
    reducer.apply(event);
  }
  return reducer.thread();
}

class NormalizedThreadReducer {
  private readonly base: NormalizedThread;
  private readonly entries: NormalizedThreadEntry[] = [];
  private status: NormalizedThreadActivity = "idle";

  /** itemId → index in `entries` of the open assistant message entry. */
  private readonly messageEntryByItem = new Map<string, number>();
  /** toolCall id → index in `entries` of the activity entry holding it. */
  private readonly activityByTool = new Map<string, number>();

  constructor(threadId: string) {
    this.base = createEmptyThread(threadId);
  }

  apply(event: NormalizedThreadEvent): void {
    switch (event.kind) {
      case "turn_started":
        this.status = "active";
        break;
      case "agent_message_delta":
        this.appendAssistantDelta("final", event.itemId, event.delta);
        break;
      case "reasoning_delta":
        // Reasoning is surfaced as assistant text when the agent's quirk says
        // so; the kit already gates this (it only emits reasoning_delta when
        // surfaceThoughts is true), so treat it like an assistant delta.
        this.appendAssistantDelta("reasoning", event.itemId, event.delta);
        break;
      case "agent_message":
        this.setAssistantMessage(event.message);
        break;
      case "tool_call":
        this.upsertToolCall(event.toolCall);
        break;
      case "tool_call_update":
        this.mergeToolCallUpdate(event.toolCall);
        break;
      case "plan_update":
        this.upsertPlan(event.plan);
        break;
      case "turn_completed":
        this.status = "idle";
        break;
      case "error":
        this.status = "idle";
        break;
      // Not part of the transcript view:
      case "token_usage":
      case "thread_settings":
      case "approval_request":
        break;
      default:
        break;
    }
  }

  thread(): NormalizedThread {
    const messages = this.entries
      .filter((e): e is NormalizedMessageEntry => e.type === "message")
      .map(
        ({ type: _t, turn: _turn, ...message }) =>
          message satisfies NormalizedMessage,
      );
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user")?.text;
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")?.text;
    return {
      ...this.base,
      entries: this.entries,
      messages,
      status: this.status,
      ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
      ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
    };
  }

  private appendAssistantDelta(
    phase: "final" | "reasoning",
    itemId: string,
    delta: string,
  ): void {
    const messageKey = `${phase}:${itemId}`;
    const existingIndex = this.messageEntryByItem.get(messageKey);
    if (existingIndex !== undefined) {
      const entry = this.entries[existingIndex] as NormalizedMessageEntry;
      entry.text += delta;
      return;
    }
    const entry: NormalizedMessageEntry = {
      type: "message",
      id: itemId,
      role: "assistant",
      text: delta,
    };
    this.messageEntryByItem.set(messageKey, this.entries.length);
    this.entries.push(entry);
  }

  private setAssistantMessage(message: NormalizedMessage): void {
    const messageKey = `final:${message.id}`;
    const existingIndex = this.messageEntryByItem.get(messageKey);
    const entry: NormalizedMessageEntry = { type: "message", ...message };
    if (existingIndex !== undefined) {
      // Some ACP normalizers finalize with reasoning+final text combined after
      // emitting final deltas. The in-tree replay keeps the final answer lane
      // separate, so preserve the streamed final entry.
      return;
    }
    const reasoningIndex = this.messageEntryByItem.get(
      `reasoning:${message.id}`,
    );
    if (reasoningIndex !== undefined) {
      const reasoningEntry = this.entries[
        reasoningIndex
      ] as NormalizedMessageEntry;
      if (reasoningEntry.text === message.text) {
        return;
      }
    }
    this.messageEntryByItem.set(messageKey, this.entries.length);
    this.entries.push(entry);
  }

  private upsertToolCall(toolCall: NormalizedToolCall): void {
    const existingIndex = this.activityByTool.get(toolCall.id);
    if (existingIndex !== undefined) {
      const entry = this.entries[existingIndex] as NormalizedActivityEntry;
      entry.toolCalls = [toolCall];
      entry.summary = toolCall.label;
      entry.status = toolCall.status;
      return;
    }
    const entry: NormalizedActivityEntry = {
      type: "activity",
      id: toolCall.id,
      summary: toolCall.label,
      status: toolCall.status,
      toolCalls: [toolCall],
    };
    this.activityByTool.set(toolCall.id, this.entries.length);
    this.entries.push(entry);
  }

  private mergeToolCallUpdate(update: NormalizedToolCallUpdate): void {
    const existingIndex = this.activityByTool.get(update.id);
    if (existingIndex === undefined) {
      // An update before its create — synthesize a tool call from the partial.
      this.upsertToolCall({
        id: update.id,
        name: update.name ?? "tool_call",
        kind: update.kind ?? "other",
        label: update.label ?? update.name ?? "Tool call",
        status: update.status ?? "in_progress",
      });
      return;
    }
    const entry = this.entries[existingIndex] as NormalizedActivityEntry;
    const prev = entry.toolCalls[0]!;
    const merged = mergeToolCall(prev, update);
    entry.toolCalls = [merged];
    entry.summary = merged.label;
    entry.status = merged.status;
  }

  private upsertPlan(plan: NormalizedPlan): void {
    const existingIndex = this.entries.findIndex(
      (e) => e.type === "plan" && e.id === plan.id,
    );
    const entry: NormalizedPlanEntry = { type: "plan", ...plan };
    if (existingIndex >= 0) {
      this.entries[existingIndex] = entry;
      return;
    }
    this.entries.push(entry);
  }
}
