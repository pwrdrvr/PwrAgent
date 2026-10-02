import type { ThreadItem } from "@pwrdrvr/codex-app-server-protocol/v2";

type CollabAgentToolCall = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

/** Adapt Codex's path-based worker activity to our existing native-agent surface. */
export function subAgentActivityToolCall(
  item: Record<string, unknown>,
): CollabAgentToolCall | undefined {
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
  if (!["started", "interacted", "interrupted", "completed"].includes(String(kind))) {
    return undefined;
  }
  const name = item.agentPath.split("/").filter(Boolean).at(-1);
  return {
    type: "collabAgentToolCall",
    id: item.id,
    tool: kind === "started" ? "spawnAgent"
      : kind === "completed" ? "wait"
        : kind === "interrupted" ? "closeAgent" : "sendInput",
    status: "completed",
    senderThreadId: "",
    receiverThreadIds: [item.agentThreadId],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {
      [item.agentThreadId]: {
        status: kind === "completed" ? "completed"
          : kind === "interrupted" ? "interrupted" : "running",
        message: null,
        ...(name ? { agentNickname: name } : {}),
      },
    },
  };
}
