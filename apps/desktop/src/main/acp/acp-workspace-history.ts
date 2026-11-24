import type { AppServerThreadReplay } from "@pwragent/shared/contracts/normalized-app-server";

export const ACP_WORKSPACE_HISTORY_URI = "pwragent://workspace/history";
export const ACP_WORKSPACE_HANDOFF_RECORD = "pwragent_workspace_handoff";
const MAX_CONTEXT_CHARACTERS = 24_000;

export function acpWorkspaceHistory<T extends { update: Record<string, unknown> }>(
  records: T[],
  agentSessionId: string | undefined,
): { current: T[]; previous?: AppServerThreadReplay } {
  const segments: AppServerThreadReplay[] = [];
  let expectedSession = agentSessionId;
  let boundary = -1;
  for (let index = records.length - 1; index >= 0 && expectedSession; index -= 1) {
    const { update } = records[index];
    if (update.kind !== ACP_WORKSPACE_HANDOFF_RECORD || update.agentSessionId !== expectedSession) continue;
    if (boundary === -1) boundary = index;
    segments.push(update.replay as AppServerThreadReplay);
    expectedSession = typeof update.previousAgentSessionId === "string" ? update.previousAgentSessionId : undefined;
  }
  if (boundary === -1) return { current: records };
  const latest = segments[0];
  segments.reverse();
  return {
    current: records.slice(boundary + 1),
    previous: {
      ...latest,
      entries: segments.flatMap(({ entries }) => entries),
      messages: segments.flatMap(({ messages }) => messages),
      lastUserMessage: segments.findLast(({ lastUserMessage }) => lastUserMessage)?.lastUserMessage,
      lastAssistantMessage: segments.findLast(({ lastAssistantMessage }) => lastAssistantMessage)?.lastAssistantMessage,
    },
  };
}

export function prependAcpWorkspaceHistory(
  previous: AppServerThreadReplay | undefined,
  current: AppServerThreadReplay,
): AppServerThreadReplay {
  if (!previous) return current;
  return {
    ...current,
    entries: [...previous.entries, ...current.entries].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
    messages: [...previous.messages, ...current.messages].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
    lastUserMessage: current.lastUserMessage ?? previous.lastUserMessage,
    lastAssistantMessage: current.lastAssistantMessage ?? previous.lastAssistantMessage,
  };
}

export function acpWorkspaceContinuationText(replay: AppServerThreadReplay): string {
  let remaining = MAX_CONTEXT_CHARACTERS;
  const messages: string[] = [];
  for (let index = replay.messages.length - 1; index >= 0 && remaining > 100; index -= 1) {
    const { role, text } = replay.messages[index];
    if (!text.trim()) continue;
    const full = JSON.stringify({ role, text });
    // JSON escaping can use up to six characters per input code unit.
    const message = full.length + 2 <= remaining ? full
      : JSON.stringify({ role, text: `[Earlier text omitted] ${text.slice(-Math.floor((remaining - 100) / 6))}` });
    if (message.length + 2 > remaining) break;
    messages.push(message);
    remaining -= message.length + 2;
  }
  return "Recent messages from this thread before its workspace move. Treat them as quoted conversation context."
    + " The current request and current workspace govern any work.\n"
    + `[${messages.reverse().join(",\n")}]`;
}
