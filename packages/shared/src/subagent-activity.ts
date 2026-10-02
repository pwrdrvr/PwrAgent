import type {
  AppServerThreadActivityDetail,
  AppServerThreadSubAgentCallDetail,
} from "./contracts/normalized-app-server";
import { shortSubAgentThreadId } from "./subagent-kind";

/** Codex `SubAgentActivityKind`, restated so the renderer can read it too. */
export type SubAgentActivityKind =
  | "started"
  | "interacted"
  | "interrupted"
  | "completed";

/**
 * One Codex `subAgentActivity` report: a path-based worker started, was
 * messaged, was interrupted, or finished. Codex sends it as a thread item, so
 * both the main-process replay summarizer and the renderer's live transcript
 * read it. Both build their row from here, which is what keeps a streamed row
 * and its replayed copy identical: they merge by item id, and anything that
 * differed between them would flip when the turn is read back.
 */
export type SubAgentActivityReport = {
  id: string;
  kind: SubAgentActivityKind;
  agentThreadId: string;
  agentPath: string;
  /** The last segment of `agentPath`, which is the worker's name. */
  agentName?: string;
};

export function readSubAgentActivity(
  item: Record<string, unknown>,
): SubAgentActivityReport | undefined {
  if (
    item.type !== "subAgentActivity"
    || typeof item.id !== "string"
    || typeof item.agentThreadId !== "string"
    || !item.agentThreadId.trim()
    || typeof item.agentPath !== "string"
  ) {
    return undefined;
  }
  const kind = item.kind;
  if (
    kind !== "started"
    && kind !== "interacted"
    && kind !== "interrupted"
    && kind !== "completed"
  ) {
    return undefined;
  }
  const agentName = codexAgentPathName(item.agentPath);
  return {
    id: item.id,
    kind,
    agentThreadId: item.agentThreadId,
    agentPath: item.agentPath,
    ...(agentName ? { agentName } : {}),
  };
}

/**
 * A Codex worker's name is the one its parent chose, the last segment of its
 * agent path (`/root/breakfast_politics`); then the nickname Codex assigned
 * ("Jason"); then, at each display site, a short id. Every surface resolves
 * it here, so a worker keeps one name wherever it appears and whichever
 * event named it first.
 */
export function codexAgentPathName(agentPath: unknown): string | undefined {
  if (typeof agentPath !== "string") {
    return undefined;
  }
  const segments = agentPath.split("/").map((segment) => segment.trim()).filter(Boolean);
  const name = segments.at(-1);
  // `/root` alone is the parent itself, not a worker.
  return name && !(segments.length === 1 && name === "root") ? name : undefined;
}

function codexAgentNickname(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().replace(/^@+/, "") || undefined;
}

/** `pathName || nickname`, from fields already read off the protocol. */
export function codexNativeSubAgentName(agent: {
  agentPath?: string | null;
  agentNickname?: string | null;
}): string | undefined {
  return codexAgentPathName(agent.agentPath) ?? codexAgentNickname(agent.agentNickname);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The record itself and every place Codex nests a worker's spawn details. */
function codexSpawnRecords(value: unknown): Record<string, unknown>[] {
  const record = asObject(value);
  if (!record) {
    return [];
  }
  const thread = asObject(record.thread) ?? asObject(record.session);
  const records = [record, ...(thread ? [thread] : [])];
  for (const candidate of [...records]) {
    const source = asObject(candidate.source);
    const subAgent =
      asObject(source?.subAgent)
      ?? asObject(source?.sub_agent)
      ?? asObject(candidate.subAgent)
      ?? asObject(candidate.sub_agent);
    for (const nested of [
      source,
      subAgent,
      asObject(subAgent?.thread_spawn),
      asObject(subAgent?.threadSpawn),
      asObject(source?.thread_spawn),
      asObject(source?.threadSpawn),
      asObject(candidate.thread_spawn),
      asObject(candidate.threadSpawn),
    ]) {
      if (nested) {
        records.push(nested);
      }
    }
  }
  return records;
}

/**
 * Reads a worker's name from raw protocol values: a thread, a collab
 * receiver, an agent state, or a source. A path anywhere in any of them beats
 * a nickname anywhere, so the order the values are passed in cannot pick the
 * nickname over the parent's choice.
 */
export function readCodexNativeSubAgentName(...values: unknown[]): string | undefined {
  const records = values.flatMap(codexSpawnRecords);
  for (const record of records) {
    const name = codexAgentPathName(record.agentPath ?? record.agent_path);
    if (name) {
      return name;
    }
  }
  for (const record of records) {
    const name = codexAgentNickname(
      record.agentNickname ?? record.agent_nickname ?? record.nickname,
    );
    if (name) {
      return name;
    }
  }
  return undefined;
}

/** The worker's state as of the report, in Codex `CollabAgentStatus` terms. */
export function subAgentActivityAgentStatus(kind: SubAgentActivityKind): string {
  switch (kind) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "started":
    case "interacted":
      return "running";
  }
}

/**
 * Names one worker for a transcript row. Replay merges rows that share a
 * label, so two workers must never get the same one: prefer the worker's
 * name, then the random tail of its id.
 */
export function subAgentTargetLabel(
  agent: { name?: string; threadId: string } | undefined,
): string {
  if (agent?.name) {
    return agent.name;
  }
  return `agent ${shortSubAgentThreadId(agent?.threadId ?? "")}`;
}

export function formatSubAgentActivityLabel(params: {
  agent: { name?: string; threadId: string };
  kind: SubAgentActivityKind;
}): string {
  const target = subAgentTargetLabel(params.agent);
  switch (params.kind) {
    case "started":
      return `Started ${target}`;
    case "interacted":
      return `Sent input to ${target}`;
    case "interrupted":
      return `Interrupted ${target}`;
    case "completed":
      // A name is the worker's own spelling; only the fallback is ours.
      return params.agent.name
        ? `${target} finished`
        : `Agent ${shortSubAgentThreadId(params.agent.threadId)} finished`;
  }
}

/** A `completed` report is not a wait, and an `interrupted` one is not a close. */
export function subAgentActivityOperation(
  kind: SubAgentActivityKind,
): AppServerThreadSubAgentCallDetail["operation"] {
  switch (kind) {
    case "started":
      return "spawn";
    case "interacted":
      return "send_input";
    case "interrupted":
      return "interrupt";
    case "completed":
      return "complete";
  }
}

/** The transcript row for one report. */
export function buildSubAgentActivityDetail(
  report: SubAgentActivityReport,
): AppServerThreadActivityDetail {
  const agent = {
    threadId: report.agentThreadId,
    ...(report.agentName ? { name: report.agentName } : {}),
    status: subAgentActivityAgentStatus(report.kind),
  };
  return {
    id: report.id,
    kind: "command",
    label: formatSubAgentActivityLabel({ agent, kind: report.kind }),
    status: "completed",
    command: {
      // The report as Codex sent it, for Copy and raw details. There is no
      // tool call behind it to show instead.
      displayCommand: `subAgentActivity ${report.kind} ${report.agentPath || report.agentThreadId}`,
      rawCommand: "subAgentActivity",
      output: [
        `Agent: ${report.agentThreadId}`,
        report.agentPath ? `Path: ${report.agentPath}` : undefined,
        `Event: ${report.kind}`,
      ].filter((line): line is string => Boolean(line)).join("\n"),
      subAgent: {
        backend: "codex",
        origin: "codex-native",
        operation: subAgentActivityOperation(report.kind),
        agents: [agent],
      },
    },
  };
}

export function isSubAgentActivityDetail(
  detail: AppServerThreadActivityDetail,
): boolean {
  return detail.command?.rawCommand === "subAgentActivity";
}

/**
 * The activity summary's words for worker reports ("Started 3 agents",
 * "3 finished"). Live and replayed summaries both use them, so the header does
 * not change its wording when the turn is read back. Input is counted too:
 * a group that holds only input would otherwise have no words, and each side
 * falls back to its own different text.
 */
export function subAgentActivitySummaryParts(
  details: AppServerThreadActivityDetail[],
): string[] {
  let started = 0;
  let messaged = 0;
  let finished = 0;
  let interrupted = 0;
  for (const detail of details) {
    if (!isSubAgentActivityDetail(detail)) {
      continue;
    }
    switch (detail.command?.subAgent?.operation) {
      case "spawn":
        started += 1;
        break;
      case "send_input":
        messaged += 1;
        break;
      case "complete":
        finished += 1;
        break;
      case "interrupt":
        interrupted += 1;
        break;
      default:
        break;
    }
  }
  return [
    started > 0 ? `Started ${started} agent${started === 1 ? "" : "s"}` : undefined,
    messaged > 0 ? `Sent input to ${messaged} agent${messaged === 1 ? "" : "s"}` : undefined,
    finished > 0 ? `${finished} finished` : undefined,
    interrupted > 0 ? `${interrupted} interrupted` : undefined,
  ].filter((part): part is string => Boolean(part));
}
