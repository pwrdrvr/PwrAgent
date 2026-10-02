import type {
  SubAgentActivityKind,
  ThreadItem,
} from "@pwrdrvr/codex-app-server-protocol/v2";

type CollabAgentToolCall = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

/**
 * Adapt Codex's path-based worker activity to our existing native-agent surface.
 *
 * The tool mapping drives lifecycle state only. A `completed` report is not a
 * wait and an `interrupted` one is not a close, so `activityKind` travels with
 * the item for anything that describes the event to the operator.
 */
export function subAgentActivityToolCall(
  item: Record<string, unknown>,
): (CollabAgentToolCall & { activityKind: SubAgentActivityKind }) | undefined {
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
  const name = item.agentPath.split("/").filter(Boolean).at(-1);
  return {
    type: "collabAgentToolCall",
    activityKind: kind,
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
