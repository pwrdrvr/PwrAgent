import type {
  CollabAgentStatus,
  ThreadItem,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import {
  readSubAgentActivity,
  subAgentActivityAgentStatus,
} from "@pwragent/shared";

type CollabAgentToolCall = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

/**
 * Adapt Codex's path-based worker activity to our existing native-agent
 * lifecycle. The tool mapping drives card state only: transcript rows come
 * from `buildSubAgentActivityDetail`, because a `completed` report is not a
 * wait and an `interrupted` one is not a close.
 */
export function subAgentActivityToolCall(
  item: Record<string, unknown>,
): CollabAgentToolCall | undefined {
  const report = readSubAgentActivity(item);
  if (!report) {
    return undefined;
  }
  return {
    type: "collabAgentToolCall",
    id: report.id,
    tool: report.kind === "started" ? "spawnAgent"
      : report.kind === "completed" ? "wait"
        : report.kind === "interrupted" ? "closeAgent" : "sendInput",
    status: "completed",
    senderThreadId: "",
    receiverThreadIds: [report.agentThreadId],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {
      [report.agentThreadId]: {
        status: subAgentActivityAgentStatus(report.kind) as CollabAgentStatus,
        message: null,
        ...(report.agentName ? { agentNickname: report.agentName } : {}),
      },
    },
  };
}
