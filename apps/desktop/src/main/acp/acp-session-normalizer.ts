import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessage,
  AppServerThreadMessagePart,
  AppServerThreadPlanEntry,
  AppServerThreadReplay,
  AppServerThreadStatus,
  AppServerTranscriptPhase,
} from "@pwragent/shared";
import {
  isGenericShellToolTitle,
  readAcpToolCommand,
  readAcpToolContentCommand,
  readAcpToolInvocation,
  readAcpWebFetchUrl,
  readAcpWebSearch,
} from "./acp-command-extraction.js";
import { sanitizeAcpToolOutput } from "./acp-tool-output.js";

export type AcpSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
  receivedAt?: number;
  /**
   * Live clients defer Grok's durable replay terminal until session/prompt
   * resolves, which is the point at which another turn may safely start.
   */
  deferTurnCompletion?: boolean;
};

export type AcpSessionReplayNormalizerOptions = {
  surfaceThoughtsAsMessages?: boolean;
};

export function shouldSurfaceAcpThoughtsAsMessages(backendId: string): boolean {
  return backendId !== "acp:qwen";
}

export function isGrokTransientUpdateKind(kind: string | undefined): boolean {
  return (
    kind === "tool_call_delta_chunk"
    || kind === "pending_interaction"
    || kind === "interaction_resolved"
  );
}

export class AcpSessionReplayNormalizer {
  private entries: AppServerThreadEntry[] = [];
  private messages: AppServerThreadMessage[] = [];
  private status: AppServerThreadStatus = "idle";
  private currentTurnId?: string;
  private currentTurnStartedAt?: number;
  private activeAssistantMessageId?: string;
  private activeAssistantMessagePhase?: AppServerTranscriptPhase;
  private assistantMessageSequence = 0;
  private generatedMessageSequence = 0;

  constructor(private readonly options: AcpSessionReplayNormalizerOptions = {}) {}

  recordUserPrompt(params: {
    sessionId: string;
    prompt: string;
    parts?: AppServerThreadMessagePart[];
    turnId: string;
    receivedAt?: number;
    waitingForAgent?: boolean;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    const id = `user:${params.turnId}`;
    const normalizedPrompt = normalizeUserPrompt(params.prompt, params.parts);
    this.currentTurnId = params.turnId;
    this.currentTurnStartedAt = createdAt;
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.assistantMessageSequence = 0;
    this.upsertMessage({
      id,
      role: "user",
      text: normalizedPrompt.text,
      ...(normalizedPrompt.parts?.length ? { parts: normalizedPrompt.parts } : {}),
      createdAt,
    });
    if (params.waitingForAgent) {
      this.upsertAgentWaitingActivity(params.turnId, createdAt);
    }
    this.status = "active";
    return this.replay();
  }

  recordTurnFinished(
    turnId?: string,
    completedAt = Date.now(),
  ): AppServerThreadReplay {
    const completedTurnId = turnId ?? this.currentTurnId;
    if (completedTurnId) {
      this.removeAgentWaitingActivity(completedTurnId);
      this.completeTurnEntries(completedTurnId, "completed", completedAt);
    } else {
      this.removeCurrentAgentWaitingActivity();
    }
    if (!turnId || this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
      this.currentTurnStartedAt = undefined;
    }
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.status = "idle";
    return this.replay();
  }

  recordTurnFailed(params: {
    sessionId: string;
    turnId: string;
    error: string;
    receivedAt?: number;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    this.removeAgentWaitingActivity(params.turnId);
    this.completeTurnEntries(params.turnId, "failed", createdAt);
    if (this.currentTurnId === params.turnId) {
      this.currentTurnId = undefined;
      this.currentTurnStartedAt = undefined;
    }
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = undefined;
    this.status = "idle";
    this.upsertActivity({
      type: "activity",
      id: `turn-failed:${params.turnId}`,
      createdAt,
      summary: "Turn failed",
      tone: "warning",
      status: "failed",
      turn: {
        id: params.turnId,
        status: "failed",
        completedAt: createdAt,
      },
      details: [
        {
          id: `turn-failed:${params.turnId}:detail`,
          kind: "read",
          label: params.error,
          status: "failed",
        },
      ],
    });
    return this.replay();
  }

  apply(update: AcpSessionUpdate): AppServerThreadReplay {
    const kind = readKind(update.update);
    const createdAt = update.receivedAt ?? Date.now();
    if (
      kind === "agent_thought_chunk" &&
      this.options.surfaceThoughtsAsMessages === false
    ) {
      return this.replay();
    }
    const isAssistantTextUpdate =
      kind === "agent_message_chunk" || kind === "agent_thought_chunk";

    if (isAssistantTextUpdate) {
      // Consecutive ACP text chunks form one live bubble, but text after a tool
      // call should become a new bubble instead of overwriting earlier text.
      const text =
        readContentText(update.update, "content") ??
        readString(update.update, "text") ??
        "";
      if (text && !isModeUpdateMarker(text) && this.currentTurnId) {
        this.removeAgentWaitingActivity(this.currentTurnId);
      }
      if (kind === "agent_message_chunk") {
        this.resetAssistantMessageIfPhaseChanged("final");
        this.applyAgentMessageChunk(update, createdAt);
      } else {
        this.resetAssistantMessageIfPhaseChanged("commentary");
        this.applyAgentThoughtChunk(update, createdAt);
      }
    } else if (kind === "user_message_chunk") {
      this.activeAssistantMessageId = undefined;
      this.activeAssistantMessagePhase = undefined;
      this.applyUserMessageChunk(update, createdAt);
    } else if (kind === "available_commands_update") {
      // Command metadata belongs in provider capabilities, not the transcript.
    } else if (
      kind === "config_option_update" ||
      kind === "current_mode_update" ||
      kind === "model_changed"
    ) {
      // Runtime configuration changes belong in ACP session metadata.
    } else if (isGrokTransientUpdateKind(kind)) {
      // Grok emits these transient xAI extension updates in addition to the
      // canonical ACP tool calls and permission requests. They are transport
      // state, not transcript entries, and must not split assistant bubbles.
    } else if (kind === "turn_completed") {
      // Grok persists this as a durable replay terminal, but emits it before
      // the live session/prompt request resolves. The client defers the live
      // idle transition until prompt resolution so queued work cannot overlap.
      if (!update.deferTurnCompletion) {
        this.recordTurnFinished(undefined, createdAt);
      }
    } else if (readAcpTopicTitle(update.update)) {
      // Topic updates are thread metadata, not transcript entries.
    } else {
      this.activeAssistantMessageId = undefined;
      this.activeAssistantMessagePhase = undefined;
      if (kind === "plan") {
        this.removeCurrentAgentWaitingActivity();
        this.upsertPlan(update, createdAt);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        this.removeCurrentAgentWaitingActivity();
        this.upsertActivity(toolActivity(update, kind, createdAt));
      } else if (kind === "file" || kind === "terminal") {
        this.removeCurrentAgentWaitingActivity();
        this.upsertActivity(toolActivity(update, kind, createdAt));
      } else if (kind === "turn_started") {
        this.status = "active";
      } else if (kind === "turn_finished") {
        this.recordTurnFinished(readString(update.update, "turnId"), createdAt);
      } else if (kind === "pwragent_turn_failed") {
        this.recordTurnFailed({
          sessionId: update.sessionId,
          turnId: readString(update.update, "turnId") ?? `pending:${update.sessionId}`,
          error: readString(update.update, "error") ?? "Turn failed.",
          receivedAt: createdAt,
        });
      } else if (kind === "pwragent_user_prompt") {
        this.recordUserPrompt({
          sessionId: update.sessionId,
          prompt: readString(update.update, "prompt") ?? "",
          parts: readMessageParts(update.update),
          turnId: readString(update.update, "turnId") ?? `pending:${update.sessionId}`,
          receivedAt: createdAt,
          waitingForAgent: readBoolean(update.update, "waitingForAgent"),
        });
      } else {
        this.removeCurrentAgentWaitingActivity();
        this.upsertActivity(unknownActivity(update, kind, createdAt));
      }
    }

    return this.replay();
  }

  replay(): AppServerThreadReplay {
    return {
      entries: this.entries,
      messages: this.messages,
      lastUserMessage: [...this.messages]
        .reverse()
        .find((message) => message.role === "user")?.text,
      lastAssistantMessage: [...this.messages]
        .reverse()
        .find((message) => message.role === "assistant")?.text,
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
      threadStatus: this.status,
    };
  }

  private applyAgentMessageChunk(update: AcpSessionUpdate, createdAt: number): void {
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
    if (!text || isModeUpdateMarker(text)) {
      return;
    }
    const id = this.assistantMessageIdForChunk(update);
    this.appendMessageChunk({
      id,
      phase: "final",
      role: "assistant",
      text,
      createdAt,
    });
  }

  private applyUserMessageChunk(update: AcpSessionUpdate, createdAt: number): void {
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
    if (isAcpUserBoilerplateMessage(text)) {
      // Gemini re-emits its <session_context> environment block (date, OS,
      // workspace dir, directory tree) as a user_message_chunk on session/load.
      // ACP agents can also replay synthetic <system-reminder> prompts. These
      // are setup/control text the agent saw, not user-authored turns.
      return;
    }
    if (this.currentTurnId) {
      const localPromptId = `user:${this.currentTurnId}`;
      if (this.messages.some((message) => message.id === localPromptId)) {
        return;
      }
    }
    const lastUserMessage = [...this.messages]
      .reverse()
      .find((message) => message.role === "user");
    if (lastUserMessage?.text.trim() === text.trim()) {
      return;
    }
    const id =
      readString(update.update, "messageId") ??
      readString(update.update, "id") ??
      `user:${update.sessionId}:${createdAt}:${this.generatedMessageSequence++}`;
    this.appendMessageChunk({ id, role: "user", text, createdAt });
  }

  private applyAgentThoughtChunk(update: AcpSessionUpdate, createdAt: number): void {
    if (this.options.surfaceThoughtsAsMessages === false) {
      return;
    }
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
    if (!text) {
      return;
    }
    const id = this.assistantMessageIdForChunk(update);
    this.appendMessageChunk({
      id,
      phase: "commentary",
      role: "assistant",
      text,
      createdAt,
    });
  }

  private assistantMessageIdForChunk(update: AcpSessionUpdate): string {
    const explicitId =
      readString(update.update, "messageId") ??
      readString(update.update, "message_id");
    if (explicitId) {
      this.activeAssistantMessageId = explicitId;
      return explicitId;
    }
    if (!this.activeAssistantMessageId) {
      this.activeAssistantMessageId =
        `assistant:${this.currentTurnId ?? update.sessionId}:${this.assistantMessageSequence++}`;
    }
    return this.activeAssistantMessageId;
  }

  private resetAssistantMessageIfPhaseChanged(
    phase: AppServerTranscriptPhase
  ): void {
    if (this.activeAssistantMessagePhase === phase) {
      return;
    }
    this.activeAssistantMessageId = undefined;
    this.activeAssistantMessagePhase = phase;
  }

  private upsertPlan(update: AcpSessionUpdate, createdAt: number): void {
    const id = readString(update.update, "planId") ?? `plan:${update.sessionId}`;
    const steps = readPlanSteps(update.update);
    const plan: AppServerThreadPlanEntry = {
      type: "plan",
      id,
      createdAt,
      explanation: readString(update.update, "explanation"),
      markdown: readString(update.update, "markdown"),
      steps,
    };
    this.upsertEntry(plan);
  }

  private upsertActivity(activity: AppServerThreadActivityEntry): void {
    const activityWithTurn = this.withCurrentTurn(activity);
    const index = this.entries.findIndex(
      (existing): existing is AppServerThreadActivityEntry =>
        existing.type === "activity" && existing.id === activityWithTurn.id,
    );
    if (index === -1) {
      this.entries.push(activityWithTurn);
      return;
    }
    this.entries[index] = mergeActivity(
      this.entries[index] as AppServerThreadActivityEntry,
      activityWithTurn,
    );
  }

  private upsertAgentWaitingActivity(turnId: string, createdAt: number): void {
    this.upsertActivity({
      type: "activity",
      id: agentWaitingActivityId(turnId),
      createdAt,
      summary: "Waiting for agent response",
      status: "in_progress",
      turn: {
        id: turnId,
        status: "in_progress",
        startedAt: createdAt,
      },
      details: [
        {
          id: `${agentWaitingActivityId(turnId)}:detail`,
          kind: "read",
          label: "The prompt was sent. Waiting for the agent provider to respond.",
          status: "in_progress",
        },
      ],
    });
  }

  private removeCurrentAgentWaitingActivity(): void {
    if (this.currentTurnId) {
      this.removeAgentWaitingActivity(this.currentTurnId);
    }
  }

  private removeAgentWaitingActivity(turnId: string): void {
    this.entries = this.entries.filter(
      (entry) => entry.id !== agentWaitingActivityId(turnId),
    );
  }

  private upsertEntry(entry: AppServerThreadEntry): void {
    const entryWithTurn = this.withCurrentTurn(entry);
    const index = this.entries.findIndex(
      (existing) => existing.id === entryWithTurn.id,
    );
    if (index === -1) {
      this.entries.push(entryWithTurn);
      return;
    }
    this.entries[index] = entryWithTurn;
  }

  private upsertMessage(message: AppServerThreadMessage): void {
    const existingMessageIndex = this.messages.findIndex(
      (existing) => existing.id === message.id,
    );
    if (existingMessageIndex === -1) {
      this.messages.push(message);
    } else {
      this.messages[existingMessageIndex] = message;
    }

    this.upsertEntry({
      type: "message",
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.parts?.length ? { parts: message.parts } : {}),
      createdAt: message.createdAt,
    });
  }

  private appendMessageChunk(params: {
    id: string;
    phase?: AppServerTranscriptPhase;
    role: "assistant" | "user";
    text: string;
    createdAt: number;
  }): void {
    const existingMessage = this.messages.find(
      (message) => message.id === params.id,
    );
    if (existingMessage) {
      existingMessage.text = appendTranscriptChunk(existingMessage.text, params.text);
    } else {
      this.messages.push({
        id: params.id,
        role: params.role,
        text: params.text,
        createdAt: params.createdAt,
      });
    }

    const existingEntry = this.entries.find(
      (entry): entry is AppServerThreadEntry & { type: "message" } =>
        entry.type === "message" && entry.id === params.id,
    );
    if (existingEntry) {
      existingEntry.text = appendTranscriptChunk(existingEntry.text, params.text);
    } else {
      this.entries.push(this.withCurrentTurn({
        type: "message",
        id: params.id,
        phase: params.phase,
        role: params.role,
        text: params.text,
        createdAt: params.createdAt,
      }));
    }
  }

  private withCurrentTurn<T extends AppServerThreadEntry>(entry: T): T {
    if (!this.currentTurnId) {
      return entry;
    }
    return {
      ...entry,
      turn: {
        id: this.currentTurnId,
        status: "in_progress",
        ...(this.currentTurnStartedAt !== undefined
          ? { startedAt: this.currentTurnStartedAt }
          : {}),
      },
    };
  }

  private completeTurnEntries(
    turnId: string,
    status: "completed" | "failed",
    completedAt: number,
  ): void {
    this.entries = this.entries.map((entry) => {
      if (entry.turn?.id !== turnId) {
        return entry;
      }
      const startedAt = entry.turn.startedAt ?? this.currentTurnStartedAt;
      return {
        ...entry,
        turn: {
          ...entry.turn,
          status,
          completedAt,
          ...(startedAt !== undefined
            ? {
                startedAt,
                durationMs: Math.max(0, completedAt - startedAt),
              }
            : {}),
        },
      };
    });
  }
}

function appendTranscriptChunk(existing: string, next: string): string {
  if (!existing || !next) {
    return `${existing}${next}`;
  }
  if (shouldSeparateTranscriptChunks(existing, next)) {
    return `${existing}\n\n${next}`;
  }
  return `${existing}${next}`;
}

function shouldSeparateTranscriptChunks(existing: string, next: string): boolean {
  if (/\s$/.test(existing)) {
    return false;
  }
  return /^(?:#{1,6}\s|\*\*[^*]+?\*\*(?:\s|$))/.test(next);
}

function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "session_update") ??
    readString(update, "kind") ??
    readString(update, "type") ??
    "unknown"
  );
}

export function readAcpTopicTitle(
  update: Record<string, unknown>,
): string | undefined {
  const sessionUpdate =
    readString(update, "sessionUpdate") ?? readString(update, "session_update");

  // Grok ACP emits a dedicated vendor notification at the end of the first
  // turn carrying the auto-generated session title:
  //   { method: "_x.ai/session_notification",
  //     params: { sessionId, update: { sessionUpdate: "session_summary_generated",
  //                                    session_summary: "<title text>" } } }
  // The acp-client routes that vendor method through the same applySessionUpdate
  // path as standard session/update, so the inner `update` lands here. Extract
  // the summary verbatim — no parsing required, unlike the tool-call path below.
  if (sessionUpdate === "session_summary_generated") {
    const summary = (
      readString(update, "session_summary") ??
      readString(update, "sessionSummary")
    )?.trim();
    return summary || undefined;
  }

  const kind = readString(update, "kind");
  const isToolUpdate =
    sessionUpdate === "tool_call" ||
    sessionUpdate === "tool_call_update" ||
    kind === "tool_call" ||
    kind === "tool_call_update" ||
    kind === "think";
  if (!isToolUpdate) {
    return undefined;
  }

  const title = readString(update, "title")?.trim();
  if (!title) {
    return undefined;
  }
  const quotedMatch = /^Update topic to:\s*["“](.+?)["”]\s*$/iu.exec(title);
  const fallbackMatch = /^Update topic to:\s*(.+)$/iu.exec(title);
  const topic = (quotedMatch?.[1] ?? fallbackMatch?.[1])?.trim();
  return topic || undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function agentWaitingActivityId(turnId: string): string {
  return `agent-waiting:${turnId}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readMessageParts(
  record: Record<string, unknown>,
): AppServerThreadMessagePart[] | undefined {
  const value = record.parts;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((part): AppServerThreadMessagePart[] => {
    const item = asRecord(part);
    if (!item) {
      return [];
    }
    if (item.type === "image") {
      const url = readString(item, "url");
      const alt = readString(item, "alt");
      return url
        ? [
            {
              type: "image",
              url,
              ...(alt ? { alt } : {}),
            } satisfies AppServerThreadImagePart,
          ]
        : [];
    }
    if (item.type === "text") {
      const text = readString(item, "text");
      return text ? [{ type: "text", text }] : [];
    }
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function normalizeUserPrompt(
  prompt: string,
  parts: AppServerThreadMessagePart[] | undefined,
): { text: string; parts?: AppServerThreadMessagePart[] } {
  if (parts?.length) {
    return { text: prompt, parts };
  }

  const images: AppServerThreadImagePart[] = [];
  const text = prompt
    .replace(
      /\s*\[Image:\s*(data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)\]\s*/giu,
      (_match, url: string) => {
        images.push({ type: "image", url });
        return "\n";
      },
    )
    .trim();

  if (images.length === 0) {
    return { text: prompt };
  }

  return {
    text,
    parts: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images,
    ],
  };
}

function readToolOutput(record: Record<string, unknown>): string | undefined {
  const contentText = readContentText(record, "content");
  return sanitizeAcpToolOutput(
    readString(record, "output")
      ?? readString(record, "stdout")
      ?? readString(record, "stderr")
      ?? readString(record, "result")
      ?? (readAcpToolContentCommand(record) ? undefined : contentText),
  );
}

function isModeUpdateMarker(text: string): boolean {
  return /^\[MODE_UPDATE\]\s*[A-Za-z0-9_-]+\s*$/.test(text.trim());
}

function readContentText(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return readAcpContentText(record[key]);
}

/**
 * Whether a message's text is the Gemini CLI `<session_context>` environment
 * block — the date/OS/workspace/directory-tree preamble Gemini injects (and
 * re-emits as a user_message_chunk on session/load). It is agent boilerplate,
 * not a user turn, so it must never appear in the transcript. Used both to keep
 * it out of the rendered replay and to stop persisting it into the rollout.
 */
export function isAcpSessionContextBoilerplate(text: string | undefined): boolean {
  return text !== undefined && text.trimStart().startsWith("<session_context>");
}

export function isAcpSystemReminderBoilerplate(text: string | undefined): boolean {
  return text !== undefined && text.trimStart().startsWith("<system-reminder>");
}

export function isAcpUserBoilerplateMessage(text: string | undefined): boolean {
  return (
    isAcpSessionContextBoilerplate(text) ||
    isAcpSystemReminderBoilerplate(text)
  );
}

export function readAcpContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => readAcpContentText(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const content = value as Record<string, unknown>;
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return (
    readAcpContentText(content.content) ??
    readAcpContentText(content.text) ??
    readAcpContentText(content.output) ??
    readAcpContentText(content.result)
  );
}

function readPlanSteps(record: Record<string, unknown>): AppServerThreadPlanEntry["steps"] {
  const steps = Array.isArray(record.steps) ? record.steps : [];
  return steps.flatMap((step) => {
    if (typeof step === "string") {
      return [{ step, status: "pending" as const }];
    }
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return [];
    }
    const stepRecord = step as Record<string, unknown>;
    const text = readString(stepRecord, "step") ?? readString(stepRecord, "content");
    if (!text) {
      return [];
    }
    const status = readString(stepRecord, "status");
    return [
      {
        step: text,
        status:
          status === "in_progress" || status === "completed"
            ? status
            : "pending",
      },
    ];
  });
}

function toolActivity(
  update: AcpSessionUpdate,
  kind: string,
  createdAt: number,
): AppServerThreadActivityEntry {
  const id =
    readString(update.update, "toolCallId") ??
    readString(update.update, "tool_call_id") ??
    readString(update.update, "id") ??
    readString(update.update, "itemId") ??
    readString(update.update, "item_id") ??
    `${kind}:${update.sessionId}`;
  const webSearch = readAcpWebSearch(update.update);
  if (webSearch) {
    const status = normalizeToolActivityStatus(readString(update.update, "status"));
    const summary = status === "in_progress" ? "Searching Web" : "Searched Web";
    const detailLabel = webSearch.query
      ? `${summary}: ${webSearch.query}`
      : summary;
    return {
      type: "activity",
      id,
      createdAt,
      summary,
      status,
      details:
        webSearch.query || webSearch.sources.length
          ? [
              {
                id: `${id}:detail`,
                kind: "read",
                label: detailLabel,
                status,
              },
              ...webSearch.sources.slice(0, 5).flatMap((source, index) => {
                const label = source.title ?? source.url;
                return label
                  ? [
                      {
                        id: `${id}:source:${index + 1}`,
                        kind: "read" as const,
                        label,
                        url: source.url,
                      },
                    ]
                  : [];
              }),
            ]
          : [],
    };
  }

  const webFetchUrl = readAcpWebFetchUrl(update.update);
  const rawCommand = readAcpToolCommand(update.update);
  const invocation = readAcpToolInvocation(update.update);
  const displayCommand = rawCommand ?? invocation;
  const labelCandidate =
    readString(update.update, "title") ??
    readString(update.update, "name") ??
    readString(update.update, "kind") ??
    kind.replaceAll("_", " ");
  const label = webFetchUrl
    ? `Fetched ${webFetchUrl}`
    : displayCommand && isGenericShellToolTitle(labelCandidate)
      ? displayCommand
      : labelCandidate;
  const status = readString(update.update, "status");
  const path = readString(update.update, "path") ?? readFirstLocationPath(update.update);
  const output = readToolOutput(update.update);
  const exitCode = readNumber(update.update, "exitCode");
  const detailKind = rawCommand
    ? "command"
    : webFetchUrl
      ? "read"
      : toolDetailKind(readString(update.update, "kind"), path);

  return {
    type: "activity",
    id,
    createdAt,
    summary: label,
    status:
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "in_progress" ||
      status === "pending"
        ? status === "pending"
          ? "in_progress"
          : status
        : undefined,
    details: [
      {
        id: `${id}:detail`,
        kind: detailKind,
        label,
        path,
        command:
          displayCommand || output !== undefined || exitCode !== undefined
            ? {
                displayCommand: displayCommand ?? label,
                rawCommand,
                ...(invocation && !rawCommand ? { source: "tool" as const } : {}),
                output,
                exitCode,
              }
            : undefined,
      },
    ],
  };
}

function normalizeToolActivityStatus(
  status: string | undefined,
): AppServerThreadActivityEntry["status"] {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "in_progress"
    ? status
    : "in_progress";
}

function mergeActivity(
  existing: AppServerThreadActivityEntry,
  incoming: AppServerThreadActivityEntry,
): AppServerThreadActivityEntry {
  return {
    ...existing,
    createdAt: existing.createdAt ?? incoming.createdAt,
    summary: preferSpecificLabel(existing.summary, incoming.summary),
    status: incoming.status ?? existing.status,
    details: mergeActivityEntryDetails(existing.details, incoming.details),
  };
}

function mergeActivityEntryDetails(
  existing: AppServerThreadActivityEntry["details"],
  incoming: AppServerThreadActivityEntry["details"],
): AppServerThreadActivityEntry["details"] {
  const merged = [...existing];
  for (const incomingDetail of incoming) {
    const existingIndex = merged.findIndex(
      (detail) => detail.id === incomingDetail.id,
    );
    if (existingIndex < 0) {
      merged.push(incomingDetail);
      continue;
    }
    const existingDetail = merged[existingIndex];
    if (!existingDetail) {
      continue;
    }
    merged[existingIndex] = {
      ...existingDetail,
      ...incomingDetail,
      kind:
        isGenericActivityLabel(incomingDetail.label)
        && !isGenericActivityLabel(existingDetail.label)
          ? existingDetail.kind
          : incomingDetail.kind,
      label: preferSpecificLabel(existingDetail.label, incomingDetail.label),
      path: incomingDetail.path ?? existingDetail.path,
      command:
        existingDetail.command || incomingDetail.command
          ? {
              displayCommand:
                preferSpecificCommand(
                  existingDetail.command?.displayCommand,
                  incomingDetail.command?.displayCommand,
                )
                ?? preferSpecificLabel(existingDetail.label, incomingDetail.label),
              rawCommand:
                preferSpecificCommand(
                  existingDetail.command?.rawCommand,
                  incomingDetail.command?.rawCommand,
                ),
              source:
                incomingDetail.command?.rawCommand
                && existingDetail.command?.source === "tool"
                  ? "shell"
                  : incomingDetail.command?.source
                    ?? existingDetail.command?.source,
              output:
                incomingDetail.command?.output
                ?? existingDetail.command?.output,
              exitCode:
                incomingDetail.command?.exitCode
                ?? existingDetail.command?.exitCode,
              durationMs:
                incomingDetail.command?.durationMs
                ?? existingDetail.command?.durationMs,
              cwd:
                incomingDetail.command?.cwd
                ?? existingDetail.command?.cwd,
            }
          : undefined,
      fileDiff: incomingDetail.fileDiff ?? existingDetail.fileDiff,
    };
  }
  return merged;
}

function preferSpecificLabel(existing: string, incoming: string): string {
  if (
    existing.toLowerCase().startsWith("searching web")
    && incoming.toLowerCase().startsWith("searched web")
  ) {
    return incoming;
  }
  return isGenericActivityLabel(existing) && incoming
    ? incoming
    : existing || incoming;
}

function isGenericActivityLabel(value: string): boolean {
  return new Set([
    "bash",
    "shell",
    "sh",
    "zsh",
    "execute",
    "read",
    "write",
    "search",
    "list",
    "tool call",
    "tool_call",
    "tool call update",
    "tool_call_update",
    "searching web",
  ]).has(value.toLowerCase());
}

function preferSpecificCommand(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (!existing || isGenericShellToolTitle(existing)) {
    return incoming ?? existing;
  }
  return existing;
}

function toolDetailKind(
  toolKind: string | undefined,
  path: string | undefined,
): AppServerThreadActivityEntry["details"][number]["kind"] {
  if (toolKind === "write" || toolKind === "edit") {
    return "write";
  }
  if (toolKind === "execute" || toolKind === "exec" || toolKind === "shell") {
    return "command";
  }
  if (toolKind === "read" || toolKind === "search" || toolKind === "list") {
    return "read";
  }
  return path ? "read" : "command";
}

function readFirstLocationPath(record: Record<string, unknown>): string | undefined {
  const locations = record.locations;
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const location of locations) {
    if (!location || typeof location !== "object" || Array.isArray(location)) {
      continue;
    }
    const path = (location as Record<string, unknown>).path;
    if (typeof path === "string" && path.trim()) {
      return path;
    }
  }
  return undefined;
}

function unknownActivity(
  update: AcpSessionUpdate,
  kind: string,
  createdAt: number,
): AppServerThreadActivityEntry {
  const id = `unknown:${update.sessionId}:${createdAt}`;
  return {
    type: "activity",
    id,
    createdAt,
    summary: `ACP update: ${kind}`,
    details: [
      {
        id: `${id}:detail`,
        kind: "read",
        label: "Unknown ACP session update",
      },
    ],
  };
}
