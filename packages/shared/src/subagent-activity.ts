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
  const agentName = item.agentPath.split("/").filter(Boolean).at(-1);
  return {
    id: item.id,
    kind,
    agentThreadId: item.agentThreadId,
    agentPath: item.agentPath,
    ...(agentName ? { agentName } : {}),
  };
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
 * not change its wording when the turn is read back. Input is not counted:
 * it is message delivery, and its rows say so.
 */
export function subAgentActivitySummaryParts(
  details: AppServerThreadActivityDetail[],
): string[] {
  let started = 0;
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
    finished > 0 ? `${finished} finished` : undefined,
    interrupted > 0 ? `${interrupted} interrupted` : undefined,
  ].filter((part): part is string => Boolean(part));
}
