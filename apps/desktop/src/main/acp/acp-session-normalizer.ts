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

export type AcpSessionUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
  receivedAt?: number;
};

export class AcpSessionReplayNormalizer {
  private entries: AppServerThreadEntry[] = [];
  private messages: AppServerThreadMessage[] = [];
  private status: AppServerThreadStatus = "idle";
  private currentTurnId?: string;
  private activeAssistantMessageId?: string;
  private assistantMessageSequence = 0;
  private generatedMessageSequence = 0;

  recordUserPrompt(params: {
    sessionId: string;
    prompt: string;
    parts?: AppServerThreadMessagePart[];
    turnId: string;
    receivedAt?: number;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    const id = `user:${params.turnId}`;
    const normalizedPrompt = normalizeUserPrompt(params.prompt, params.parts);
    this.currentTurnId = params.turnId;
    this.activeAssistantMessageId = undefined;
    this.assistantMessageSequence = 0;
    this.upsertMessage({
      id,
      role: "user",
      text: normalizedPrompt.text,
      ...(normalizedPrompt.parts?.length ? { parts: normalizedPrompt.parts } : {}),
      createdAt,
    });
    this.status = "active";
    return this.replay();
  }

  recordTurnFinished(turnId?: string): AppServerThreadReplay {
    if (!turnId || this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
    }
    this.activeAssistantMessageId = undefined;
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
    if (this.currentTurnId === params.turnId) {
      this.currentTurnId = undefined;
    }
    this.activeAssistantMessageId = undefined;
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
    const isAssistantTextUpdate =
      kind === "agent_message_chunk" || kind === "agent_thought_chunk";

    if (isAssistantTextUpdate) {
      // Consecutive ACP text chunks form one live bubble, but text after a tool
      // call should become a new bubble instead of overwriting earlier text.
      if (kind === "agent_message_chunk") {
        this.applyAgentMessageChunk(update, createdAt);
      } else {
        this.applyAgentThoughtChunk(update, createdAt);
      }
    } else if (kind === "user_message_chunk") {
      this.activeAssistantMessageId = undefined;
      this.applyUserMessageChunk(update, createdAt);
    } else if (kind === "available_commands_update") {
      // Command metadata belongs in provider capabilities, not the transcript.
    } else if (kind === "config_option_update" || kind === "current_mode_update") {
      // Runtime configuration changes belong in ACP session metadata.
    } else if (readAcpTopicTitle(update.update)) {
      // Topic updates are thread metadata, not transcript entries.
    } else {
      this.activeAssistantMessageId = undefined;
      if (kind === "plan") {
        this.upsertPlan(update, createdAt);
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        this.upsertActivity(toolActivity(update, kind, createdAt));
      } else if (kind === "file" || kind === "terminal") {
        this.upsertActivity(toolActivity(update, kind, createdAt));
      } else if (kind === "turn_started") {
        this.status = "active";
      } else if (kind === "turn_finished") {
        this.recordTurnFinished(readString(update.update, "turnId"));
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
        });
      } else {
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
    if (isModeUpdateMarker(text)) {
      return;
    }
    const id = this.assistantMessageIdForChunk(update);
    this.appendMessageChunk({ id, role: "assistant", text, createdAt });
  }

  private applyUserMessageChunk(update: AcpSessionUpdate, createdAt: number): void {
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
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
    const index = this.entries.findIndex(
      (existing): existing is AppServerThreadActivityEntry =>
        existing.type === "activity" && existing.id === activity.id,
    );
    if (index === -1) {
      this.entries.push(activity);
      return;
    }
    this.entries[index] = mergeActivity(
      this.entries[index] as AppServerThreadActivityEntry,
      activity,
    );
  }

  private upsertEntry(entry: AppServerThreadEntry): void {
    const index = this.entries.findIndex((existing) => existing.id === entry.id);
    if (index === -1) {
      this.entries.push(entry);
      return;
    }
    this.entries[index] = entry;
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
      this.entries.push({
        type: "message",
        id: params.id,
        phase: params.phase,
        role: params.role,
        text: params.text,
        createdAt: params.createdAt,
      });
    }
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
  return (
    readString(record, "output") ??
    readString(record, "stdout") ??
    readString(record, "stderr") ??
    readString(record, "result") ??
    readContentText(record, "content")
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
  const label =
    readString(update.update, "title") ??
    readString(update.update, "name") ??
    readString(update.update, "kind") ??
    kind.replaceAll("_", " ");
  const status = readString(update.update, "status");
  const path = readString(update.update, "path") ?? readFirstLocationPath(update.update);
  const command = readString(update.update, "command");
  const output = readToolOutput(update.update);
  const exitCode = readNumber(update.update, "exitCode");
  const detailKind = command
    ? "command"
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
          command || output !== undefined || exitCode !== undefined
            ? {
                displayCommand: command ?? label,
                rawCommand: command,
                output,
                exitCode,
              }
            : undefined,
      },
    ],
  };
}

function mergeActivity(
  existing: AppServerThreadActivityEntry,
  incoming: AppServerThreadActivityEntry,
): AppServerThreadActivityEntry {
  const existingDetail = existing.details[0];
  const incomingDetail = incoming.details[0];
  return {
    ...existing,
    createdAt: existing.createdAt ?? incoming.createdAt,
    summary: preferSpecificLabel(existing.summary, incoming.summary),
    status: incoming.status ?? existing.status,
    details:
      existingDetail && incomingDetail
        ? [
            {
              ...existingDetail,
              ...incomingDetail,
              label: preferSpecificLabel(existingDetail.label, incomingDetail.label),
              path: incomingDetail.path ?? existingDetail.path,
              command:
                existingDetail.command || incomingDetail.command
                  ? {
                      displayCommand:
                        existingDetail.command?.displayCommand ??
                        incomingDetail.command?.displayCommand ??
                        preferSpecificLabel(existingDetail.label, incomingDetail.label),
                      rawCommand:
                        existingDetail.command?.rawCommand ??
                        incomingDetail.command?.rawCommand,
                      output:
                        incomingDetail.command?.output ??
                        existingDetail.command?.output,
                      exitCode:
                        incomingDetail.command?.exitCode ??
                        existingDetail.command?.exitCode,
                      durationMs:
                        incomingDetail.command?.durationMs ??
                        existingDetail.command?.durationMs,
                      cwd:
                        incomingDetail.command?.cwd ??
                        existingDetail.command?.cwd,
                    }
                  : undefined,
              fileDiff: incomingDetail.fileDiff ?? existingDetail.fileDiff,
            },
          ]
        : incoming.details.length > 0
          ? incoming.details
          : existing.details,
  };
}

function preferSpecificLabel(existing: string, incoming: string): string {
  const generic = new Set([
    "execute",
    "read",
    "write",
    "search",
    "list",
    "tool call",
    "tool_call",
    "tool call update",
    "tool_call_update",
  ]);
  return generic.has(existing.toLowerCase()) && incoming
    ? incoming
    : existing || incoming;
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
