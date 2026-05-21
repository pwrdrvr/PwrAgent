import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessage,
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

  recordUserPrompt(params: {
    sessionId: string;
    prompt: string;
    turnId: string;
    receivedAt?: number;
  }): AppServerThreadReplay {
    const createdAt = params.receivedAt ?? Date.now();
    const id = `user:${params.turnId}`;
    this.currentTurnId = params.turnId;
    this.upsertMessage({
      id,
      role: "user",
      text: params.prompt,
      createdAt,
    });
    this.status = "active";
    return this.replay();
  }

  recordTurnFinished(turnId?: string): AppServerThreadReplay {
    if (!turnId || this.currentTurnId === turnId) {
      this.currentTurnId = undefined;
    }
    this.status = "idle";
    return this.replay();
  }

  apply(update: AcpSessionUpdate): AppServerThreadReplay {
    const kind = readKind(update.update);
    const createdAt = update.receivedAt ?? Date.now();

    if (kind === "agent_message_chunk") {
      this.applyAgentMessageChunk(update, createdAt);
    } else if (kind === "agent_thought_chunk") {
      this.applyAgentThoughtChunk(update, createdAt);
    } else if (kind === "available_commands_update") {
      // Command metadata belongs in provider capabilities, not the transcript.
    } else if (readAcpTopicTitle(update.update)) {
      // Topic updates are thread metadata, not transcript entries.
    } else if (kind === "plan") {
      this.upsertPlan(update, createdAt);
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      this.upsertActivity(toolActivity(update, kind, createdAt));
    } else if (kind === "file" || kind === "terminal") {
      this.upsertActivity(toolActivity(update, kind, createdAt));
    } else if (kind === "turn_started") {
      this.status = "active";
    } else if (kind === "turn_finished") {
      this.recordTurnFinished(readString(update.update, "turnId"));
    } else if (kind === "pwragent_user_prompt") {
      this.recordUserPrompt({
        sessionId: update.sessionId,
        prompt: readString(update.update, "prompt") ?? "",
        turnId: readString(update.update, "turnId") ?? `pending:${update.sessionId}`,
        receivedAt: createdAt,
      });
    } else {
      this.upsertActivity(unknownActivity(update, kind, createdAt));
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
    const id =
      readString(update.update, "messageId") ??
      `assistant:${this.currentTurnId ?? update.sessionId}`;
    this.appendMessageChunk({ id, role: "assistant", text, createdAt });
  }

  private applyAgentThoughtChunk(update: AcpSessionUpdate, createdAt: number): void {
    const text =
      readContentText(update.update, "content") ??
      readString(update.update, "text") ??
      "";
    if (!text) {
      return;
    }
    const id =
      readString(update.update, "messageId") ??
      `thought:${this.currentTurnId ?? update.sessionId}`;
    this.appendMessageChunk({
      id,
      phase: "commentary",
      role: "assistant",
      text,
      createdAt,
    });
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
    this.upsertEntry(activity);
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
      existingMessage.text += params.text;
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
      existingEntry.text += params.text;
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

function readKind(update: Record<string, unknown>): string {
  return (
    readString(update, "sessionUpdate") ??
    readString(update, "kind") ??
    readString(update, "type") ??
    "unknown"
  );
}

export function readAcpTopicTitle(
  update: Record<string, unknown>,
): string | undefined {
  const sessionUpdate = readString(update, "sessionUpdate");
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

function readContentText(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const content = value as Record<string, unknown>;
  return content.type === "text" && typeof content.text === "string"
    ? content.text
    : undefined;
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
    readString(update.update, "id") ??
    `${kind}:${update.sessionId}`;
  const label =
    readString(update.update, "title") ??
    readString(update.update, "name") ??
    readString(update.update, "kind") ??
    kind.replaceAll("_", " ");
  const status = readString(update.update, "status");
  const path = readString(update.update, "path") ?? readFirstLocationPath(update.update);
  const command = readString(update.update, "command");
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
      status === "in_progress"
        ? status
        : undefined,
    details: [
      {
        id: `${id}:detail`,
        kind: detailKind,
        label,
        path,
        command: command ? { displayCommand: command, rawCommand: command } : undefined,
      },
    ],
  };
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
