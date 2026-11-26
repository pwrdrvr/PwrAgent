import type { AcpBackendId } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadSubAgentStatus } from "@pwragent/shared/contracts/navigation";
import { ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX } from "@pwragent/shared/subagent-kind";
import { shortenDerivedThreadTitle } from "@pwragent/shared/thread-titles";
import { truncateSubAgentText } from "../app-server/codex-native-subagents.js";

/**
 * The Sub-agents card for one ACP native sub-agent, whether reported through
 * protocol-level `subagent_*` updates (Grok) or a harness tool call such as
 * Antigravity's `invoke_subagent`.
 */
export type AcpSubAgentCard = {
  monitorId: string;
  subAgentId: string;
  task: string;
  displayTitle?: string;
  status: ThreadSubAgentStatus;
  agentName?: string;
  agentRole?: string;
  preferredModel?: string;
  lastMessage?: string;
  startedAt?: number;
  completedAt?: number;
};

type AcpTrackedSubAgent = {
  id: string;
  /** Tool call ID that launched this sub-agent, if started via `invoke_subagent`. */
  toolCallId?: string;
  /** Conversation/child ID if reported by the provider. */
  conversationId?: string;
  /** Active turn ID that launched an implicit-completion tool-call sub-agent. */
  turnId?: string;
  /**
   * True when the provider does not send a separate `subagent_finished` event
   * (Antigravity `invoke_subagent` returns as soon as the background worker is
   * launched and wakes the parent later in the same turn). Such workers settle
   * when the owning turn finishes, fails, is cancelled, or is superseded.
   */
  settlesWithTurn: boolean;
  /** Role or display name chosen by the parent (Antigravity `Role`). */
  role?: string;
  /** Agent type / archetype (Antigravity `TypeName`, Grok `subagent_type`). */
  subagentType?: string;
  /** Description or prompt summarizing the sub-agent's assignment. */
  description?: string;
  prompt?: string;
  model?: string;
  status: ThreadSubAgentStatus;
  lastMessage?: string;
  startedAt: number;
  completedAt?: number;
};

/**
 * Parsed metadata from an ACP `invoke_subagent` tool call, shared by the live
 * tracker and transcript renderers so the sidebar, panel, and transcript name
 * the same worker the same way.
 */
export type AcpInvokeSubAgentDetails = {
  role?: string;
  typeName?: string;
  prompt?: string;
  model?: string;
  workspace?: string;
  conversationId?: string;
};

const GENERIC_SUBAGENT_TYPES = new Set([
  "general-purpose",
  "general",
  "default",
  "self",
]);

function isGenericSubAgentType(value: string | undefined): boolean {
  return value !== undefined && GENERIC_SUBAGENT_TYPES.has(value.trim().toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTrimmedString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function readUpdateKind(update: Record<string, unknown>): string | undefined {
  return readTrimmedString(update, "sessionUpdate", "session_update", "kind", "type");
}

function readToolCallId(update: Record<string, unknown>): string | undefined {
  return readTrimmedString(update, "toolCallId", "tool_call_id", "id", "itemId", "item_id");
}

function readToolName(update: Record<string, unknown>): string | undefined {
  const direct = readTrimmedString(update, "name");
  if (direct) {
    return direct;
  }
  const metaTool = asRecord(asRecord(update._meta)?.["x.ai/tool"]);
  const metaName = readTrimmedString(metaTool, "name");
  if (metaName) {
    return metaName;
  }
  const title = readTrimmedString(update, "title");
  if (!title) {
    return undefined;
  }
  const runMatch = /^Run\s+([A-Za-z0-9_.-]+)$/u.exec(title);
  return runMatch?.[1] ?? title;
}

function readToolInputRecord(update: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(update.rawInput) ?? asRecord(update.args) ?? asRecord(update.input);
}

function readConversationIdFromOutput(update: Record<string, unknown>): string | undefined {
  const rawOutput = asRecord(update.rawOutput);
  const direct = readTrimmedString(rawOutput, "conversationId", "conversation_id", "subagent_id", "child_session_id");
  if (direct) {
    return direct;
  }
  const contentText = readContentText(update.content) ?? readTrimmedString(update, "output", "result");
  if (!contentText) {
    return undefined;
  }
  const match = /\bconversationId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})["']?/u.exec(contentText);
  return match?.[1];
}

function readContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(readContentText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (record.type === "text" && typeof record.text === "string") {
    return record.text.trim() || undefined;
  }
  return readContentText(record.content) ?? readContentText(record.text) ?? readContentText(record.output);
}

function isTerminalStatus(status: ThreadSubAgentStatus): boolean {
  return status === "success" || status === "failure" || status === "cancelled";
}

/**
 * Extracts Antigravity (or compatible ACP) `invoke_subagent` parameters from a
 * `tool_call` / `tool_call_update` payload. Returns `undefined` for unrelated
 * tool calls.
 */
export function readAcpInvokeSubAgentDetails(
  update: Record<string, unknown>,
): AcpInvokeSubAgentDetails | undefined {
  const kind = readUpdateKind(update);
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    return undefined;
  }
  if (readToolName(update) !== "invoke_subagent") {
    return undefined;
  }
  const input = readToolInputRecord(update);
  const role = readTrimmedString(input, "Role", "role", "name", "description");
  const typeName = readTrimmedString(input, "TypeName", "typeName", "subagent_type", "type");
  const prompt = readTrimmedString(input, "Prompt", "prompt");
  const rawModel = readTrimmedString(input, "Model", "model");
  const model = rawModel && rawModel.toLowerCase() !== "inherit" ? rawModel : undefined;
  const workspace = readTrimmedString(input, "Workspace", "workspace");
  const conversationId = readConversationIdFromOutput(update);
  return {
    ...(role ? { role } : {}),
    ...(typeName ? { typeName } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(workspace ? { workspace } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

/**
 * Human-readable transcript label for an ACP `invoke_subagent` tool call,
 * replacing the raw `Run invoke_subagent` placeholder.
 */
export function formatAcpInvokeSubAgentLabel(
  details: AcpInvokeSubAgentDetails,
  status?: string,
): string {
  const target =
    details.role
    ?? (details.prompt ? shortenPromptHeadline(details.prompt) : undefined)
    ?? details.typeName;
  const normalized = status?.toLowerCase();
  const verb = normalized === "failed"
    ? "Sub-agent failed"
    : normalized === "cancelled"
      ? "Sub-agent cancelled"
      : "Sub-agent";
  return target ? `${verb}: ${target}` : verb;
}

function shortenPromptHeadline(prompt: string): string | undefined {
  const shortened = shortenDerivedThreadTitle(prompt) ?? prompt;
  const trimmed = truncateSubAgentText(shortened, 96);
  return trimmed || undefined;
}

function mapFinishedStatus(rawStatus: string | undefined): ThreadSubAgentStatus {
  const normalized = rawStatus?.trim().toLowerCase();
  if (normalized === "completed" || normalized === "success" || normalized === "succeeded") {
    return "success";
  }
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "interrupted" || normalized === "stopped") {
    return "cancelled";
  }
  return "failure";
}

function buildCard(agent: AcpTrackedSubAgent): AcpSubAgentCard {
  const displayTitle =
    agent.role
    ?? agent.description
    ?? (agent.prompt ? shortenPromptHeadline(agent.prompt) : undefined)
    ?? agent.subagentType
    ?? "Sub-agent";
  const taskSource = agent.description ?? agent.prompt ?? agent.role ?? agent.subagentType ?? "Sub-agent";
  const task = truncateSubAgentText(taskSource, 360) || displayTitle;
  const hasDistinctType =
    agent.subagentType !== undefined && !isGenericSubAgentType(agent.subagentType);
  const agentName = agent.role
    ?? (!agent.description && !agent.prompt && hasDistinctType ? agent.subagentType : undefined);
  const agentRole =
    hasDistinctType && agent.subagentType !== agentName
      ? agent.subagentType
      : undefined;
  return {
    monitorId: `${ACP_NATIVE_SUBAGENT_MONITOR_ID_PREFIX}${agent.id}`,
    subAgentId: agent.id,
    task,
    ...(displayTitle && displayTitle !== task ? { displayTitle } : {}),
    status: agent.status,
    ...(agentName ? { agentName } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(agent.model ? { preferredModel: agent.model } : {}),
    ...(agent.lastMessage && isTerminalStatus(agent.status) ? { lastMessage: agent.lastMessage } : {}),
    startedAt: agent.startedAt,
    ...(agent.completedAt !== undefined ? { completedAt: agent.completedAt } : {}),
  };
}

/**
 * Tracks native sub-agents reported by one ACP session.
 *
 * Rules:
 * - Each sub-agent has a single durable card (`acp-native:<id>`).
 * - Progress updates (`subagent_progress`) never change the card snapshot, so
 *   high-frequency progress ticks cause zero SQLite writes.
 * - First terminal state is final: a settled sub-agent never moves back to
 *   `running` or changes its terminal outcome on late/redelivered events.
 * - Tool-call launches (`invoke_subagent`) run asynchronously during the parent
 *   turn: a `"completed"` launch call keeps the worker `"running"` until the
 *   parent turn finishes, fails, is cancelled, kills it via `manage_subagents`,
 *   or starts a subsequent turn. A `"failed"` or `"cancelled"` launch call
 *   settles immediately.
 * - All operations are O(1) amortized per update (no scans over history).
 */
export class AcpSubAgentTracker {
  private readonly agents = new Map<string, AcpTrackedSubAgent>();
  private readonly byConversationId = new Map<string, string>();
  private readonly activeTurnBoundIds = new Set<string>();
  private readonly pendingManageSubAgents = new Map<
    string,
    { action: "kill" | "kill_all"; conversationIds?: string[] }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** Applies one ACP `session/update` payload. Returns true if any card changed. */
  apply(params: {
    backendId?: AcpBackendId;
    turnId?: string;
    update: Record<string, unknown>;
    receivedAt?: number;
  }): boolean {
    const { update, turnId } = params;
    const kind = readUpdateKind(update);
    const timestamp = params.receivedAt ?? this.now();

    if (kind === "subagent_spawned" || kind === "subagent_progress" || kind === "subagent_finished") {
      return this.applyProtocolSubAgentUpdate(kind, update, timestamp);
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolName = readToolName(update);
      const toolCallId = readToolCallId(update);
      if (
        toolName === "invoke_subagent"
        || (kind === "tool_call_update" && toolCallId !== undefined && this.agents.has(toolCallId))
      ) {
        return this.applyInvokeSubAgentUpdate(update, turnId, timestamp);
      }
      if (
        toolName === "manage_subagents"
        || (kind === "tool_call_update" && toolCallId !== undefined && this.pendingManageSubAgents.has(toolCallId))
      ) {
        return this.applyManageSubAgentsUpdate(update, timestamp);
      }
    }

    return false;
  }

  /**
   * Called when a new turn begins on the same session: any prior turn's
   * turn-bound `invoke_subagent` workers that missed a turn terminal event are
   * settled so they never linger as running across turns.
   */
  onTurnStarted(nextTurnId: string, at?: number): boolean {
    this.pendingManageSubAgents.clear();
    if (this.activeTurnBoundIds.size === 0) {
      return false;
    }
    const timestamp = at ?? this.now();
    let changed = false;
    for (const id of [...this.activeTurnBoundIds]) {
      const agent = this.agents.get(id);
      if (!agent || isTerminalStatus(agent.status)) {
        this.activeTurnBoundIds.delete(id);
        continue;
      }
      if (agent.turnId && agent.turnId === nextTurnId) {
        continue;
      }
      this.settleAgent(agent, "success", undefined, timestamp);
      changed = true;
    }
    return changed;
  }

  /**
   * Settles sub-agents when a turn finishes, fails, or is cancelled.
   *
   * - On `"completed"`: settles turn-bound (`invoke_subagent`) sub-agents
   *   belonging to `turnId` (or without a recorded turn ID). Protocol-managed
   *   sub-agents (`subagent_spawned`) wait for their explicit
   *   `subagent_finished` event.
   * - On `"failed"` or `"cancelled"`: settles every still-running sub-agent on
   *   the session (both turn-bound and protocol-managed, regardless of turn ID)
   *   so a failed or aborted prompt never strands running cards in SQLite.
   */
  settleTurn(params: {
    turnId?: string;
    outcome: "completed" | "failed" | "cancelled";
    at?: number;
  }): boolean {
    const timestamp = params.at ?? this.now();
    if (params.outcome === "failed" || params.outcome === "cancelled") {
      return this.endRunningSubAgents(
        params.outcome === "cancelled" ? "cancelled" : "failure",
        timestamp,
      );
    }
    if (this.activeTurnBoundIds.size === 0) {
      return false;
    }
    let changed = false;
    for (const id of [...this.activeTurnBoundIds]) {
      const agent = this.agents.get(id);
      if (!agent || isTerminalStatus(agent.status)) {
        this.activeTurnBoundIds.delete(id);
        continue;
      }
      if (params.turnId && agent.turnId && agent.turnId !== params.turnId) {
        continue;
      }
      this.settleAgent(agent, "success", undefined, timestamp);
      changed = true;
    }
    return changed;
  }

  /** Ends every still-running sub-agent when the ACP session closes or disconnects. */
  endRunningSubAgents(status: "cancelled" | "failure", at?: number): boolean {
    const timestamp = at ?? this.now();
    let changed = false;
    for (const agent of this.agents.values()) {
      if (isTerminalStatus(agent.status)) {
        continue;
      }
      this.settleAgent(agent, status, undefined, timestamp);
      changed = true;
    }
    return changed;
  }

  /** Snapshot of all tracked sub-agent cards in creation order. */
  subAgentCards(): AcpSubAgentCard[] {
    const cards: AcpSubAgentCard[] = [];
    for (const agent of this.agents.values()) {
      cards.push(buildCard(agent));
    }
    return cards;
  }

  /** Number of currently running sub-agents tracked for this session. */
  activeCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (!isTerminalStatus(agent.status)) {
        count += 1;
      }
    }
    return count;
  }

  private applyProtocolSubAgentUpdate(
    kind: "subagent_spawned" | "subagent_progress" | "subagent_finished",
    update: Record<string, unknown>,
    timestamp: number,
  ): boolean {
    const rawId = readTrimmedString(update, "subagent_id", "child_session_id");
    if (!rawId) {
      return false;
    }
    const mappedId = this.byConversationId.get(rawId) ?? rawId;
    const existing = this.agents.get(mappedId);
    if (existing && isTerminalStatus(existing.status)) {
      return false;
    }

    if (kind === "subagent_progress") {
      // Progress stays in memory; it never creates or mutates a durable card.
      return false;
    }

    const description = readTrimmedString(update, "description");
    const subagentType = readTrimmedString(update, "subagent_type");
    const model = readTrimmedString(update, "model");

    if (kind === "subagent_spawned") {
      if (!existing) {
        this.agents.set(mappedId, {
          id: mappedId,
          conversationId: rawId,
          settlesWithTurn: false,
          ...(description ? { description } : {}),
          ...(subagentType ? { subagentType } : {}),
          ...(model ? { model } : {}),
          status: "running",
          startedAt: timestamp,
        });
        this.byConversationId.set(rawId, mappedId);
        return true;
      }
      let changed = false;
      if (existing.settlesWithTurn) {
        existing.settlesWithTurn = false;
        this.activeTurnBoundIds.delete(existing.id);
      }
      if (description && description !== existing.description) {
        existing.description = description;
        changed = true;
      }
      if (subagentType && subagentType !== existing.subagentType) {
        existing.subagentType = subagentType;
        changed = true;
      }
      if (model && model !== existing.model) {
        existing.model = model;
        changed = true;
      }
      return changed;
    }

    // kind === "subagent_finished"
    const terminalStatus = mapFinishedStatus(readTrimmedString(update, "status"));
    const messageSource = readTrimmedString(update, "error", "output");
    const lastMessage = messageSource ? truncateSubAgentText(messageSource, 360) : undefined;
    const agent: AcpTrackedSubAgent = existing ?? {
      id: mappedId,
      conversationId: rawId,
      settlesWithTurn: false,
      ...(description ? { description } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(model ? { model } : {}),
      status: "running",
      startedAt: timestamp,
    };
    if (!existing) {
      this.agents.set(mappedId, agent);
      this.byConversationId.set(rawId, mappedId);
    } else {
      if (description) agent.description = description;
      if (subagentType) agent.subagentType = subagentType;
      if (model) agent.model = model;
    }
    this.settleAgent(agent, terminalStatus, lastMessage, timestamp);
    return true;
  }

  private applyInvokeSubAgentUpdate(
    update: Record<string, unknown>,
    turnId: string | undefined,
    timestamp: number,
  ): boolean {
    const toolCallId = readToolCallId(update);
    const parsedDetails = readAcpInvokeSubAgentDetails(update);
    const existingByToolCall = toolCallId ? this.agents.get(toolCallId) : undefined;
    // Antigravity's sparse `tool_call_update` omits `name`/`title`/`args` and
    // carries only `toolCallId`, `status`, and optional output.
    const details: AcpInvokeSubAgentDetails | undefined = parsedDetails
      ?? (existingByToolCall
        ? {
            ...(readConversationIdFromOutput(update)
              ? { conversationId: readConversationIdFromOutput(update) }
              : {}),
          }
        : undefined);
    if (!details) {
      return false;
    }
    const id = toolCallId ?? details.conversationId;
    if (!id) {
      return false;
    }
    const existing = existingByToolCall ?? this.agents.get(id);
    if (existing && isTerminalStatus(existing.status)) {
      return false;
    }

    const rawStatus = readTrimmedString(update, "status")?.toLowerCase();
    const failedLaunch = rawStatus === "failed";
    const cancelledLaunch = rawStatus === "cancelled" || rawStatus === "canceled";

    let changed = false;
    let agent = existing;
    if (!agent) {
      agent = {
        id,
        toolCallId,
        ...(details.conversationId ? { conversationId: details.conversationId } : {}),
        ...(turnId ? { turnId } : {}),
        settlesWithTurn: true,
        ...(details.role ? { role: details.role } : {}),
        ...(details.typeName ? { subagentType: details.typeName } : {}),
        ...(details.prompt ? { prompt: details.prompt } : {}),
        ...(details.model ? { model: details.model } : {}),
        status: "running",
        startedAt: timestamp,
      };
      this.agents.set(id, agent);
      this.activeTurnBoundIds.add(id);
      if (details.conversationId) {
        this.byConversationId.set(details.conversationId, id);
      }
      changed = true;
    } else {
      if (details.role && details.role !== agent.role) {
        agent.role = details.role;
        changed = true;
      }
      if (details.typeName && details.typeName !== agent.subagentType) {
        agent.subagentType = details.typeName;
        changed = true;
      }
      if (details.prompt && details.prompt !== agent.prompt) {
        agent.prompt = details.prompt;
        changed = true;
      }
      if (details.model && details.model !== agent.model) {
        agent.model = details.model;
        changed = true;
      }
      if (details.conversationId && !agent.conversationId) {
        agent.conversationId = details.conversationId;
        this.byConversationId.set(details.conversationId, id);
      }
      if (turnId && !agent.turnId) {
        agent.turnId = turnId;
      }
    }

    if (failedLaunch || cancelledLaunch) {
      const errorText = readContentText(update.content) ?? readTrimmedString(update, "error", "output");
      this.settleAgent(
        agent,
        failedLaunch ? "failure" : "cancelled",
        errorText ? truncateSubAgentText(errorText, 360) : undefined,
        timestamp,
      );
      return true;
    }

    return changed;
  }

  private applyManageSubAgentsUpdate(
    update: Record<string, unknown>,
    timestamp: number,
  ): boolean {
    const toolCallId = readToolCallId(update);
    const rawStatus = readTrimmedString(update, "status")?.toLowerCase();
    const input = readToolInputRecord(update);
    const inputAction = readTrimmedString(input, "Action", "action")?.toLowerCase();
    const inputConversationIds = Array.isArray(input?.ConversationIds)
      ? input.ConversationIds.filter((item): item is string => typeof item === "string")
      : undefined;

    if (rawStatus === "failed" || rawStatus === "cancelled" || rawStatus === "canceled") {
      if (toolCallId) {
        this.pendingManageSubAgents.delete(toolCallId);
      }
      return false;
    }

    if (rawStatus !== "completed") {
      if (toolCallId && (inputAction === "kill_all" || inputAction === "kill")) {
        this.pendingManageSubAgents.set(toolCallId, {
          action: inputAction,
          ...(inputConversationIds ? { conversationIds: inputConversationIds } : {}),
        });
      }
      return false;
    }

    const pending = toolCallId ? this.pendingManageSubAgents.get(toolCallId) : undefined;
    if (toolCallId) {
      this.pendingManageSubAgents.delete(toolCallId);
    }
    const action = inputAction ?? pending?.action;
    const conversationIds = inputConversationIds ?? pending?.conversationIds;

    if (action === "kill_all") {
      let changed = false;
      for (const id of [...this.activeTurnBoundIds]) {
        const agent = this.agents.get(id);
        if (!agent || isTerminalStatus(agent.status)) {
          this.activeTurnBoundIds.delete(id);
          continue;
        }
        this.settleAgent(agent, "cancelled", "Stopped by parent agent.", timestamp);
        changed = true;
      }
      return changed;
    }
    if (action === "kill" && conversationIds) {
      let changed = false;
      for (const rawId of conversationIds) {
        const targetId = this.byConversationId.get(rawId.trim()) ?? rawId.trim();
        const agent = this.agents.get(targetId);
        if (!agent || isTerminalStatus(agent.status)) continue;
        this.settleAgent(agent, "cancelled", "Stopped by parent agent.", timestamp);
        changed = true;
      }
      return changed;
    }
    return false;
  }

  private settleAgent(
    agent: AcpTrackedSubAgent,
    status: ThreadSubAgentStatus,
    lastMessage: string | undefined,
    timestamp: number,
  ): void {
    agent.status = status;
    agent.completedAt = Math.max(timestamp, agent.startedAt);
    if (lastMessage) {
      agent.lastMessage = lastMessage;
    }
    this.activeTurnBoundIds.delete(agent.id);
  }
}
