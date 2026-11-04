import {
  threadTodoMessageOriginFromUnknown,
  type AppServerThreadMessageOrigin,
  type CelestialIconId,
} from "@pwragent/shared";

export type ResolvedSourceInstance = {
  label: string;
  celestialIcon?: CelestialIconId;
};

export function authenticateMessageOrigin(params: {
  messageOrigin: AppServerThreadMessageOrigin | undefined;
  resolveSourceInstance?: (
    instanceId: string,
  ) => ResolvedSourceInstance | undefined;
  sourceInstanceId: string;
}): AppServerThreadMessageOrigin | undefined {
  const sourceThread = params.messageOrigin?.sourceThread;
  if (!params.messageOrigin || !sourceThread) {
    if (params.messageOrigin?.threadTodo === undefined) return params.messageOrigin;
    // A to-do marker names the thread that raised the card; without one it is noise.
    const { threadTodo: _threadTodo, ...messageOrigin } = params.messageOrigin;
    return messageOrigin;
  }

  let sourceInstance: ResolvedSourceInstance | undefined;
  try {
    sourceInstance = params.resolveSourceInstance?.(params.sourceInstanceId);
  } catch {
    // The authenticated instance id remains useful when display metadata is
    // temporarily unavailable. Never fall back to caller-provided identity.
  }

  const { threadTodo: rawThreadTodo, ...messageOrigin } = params.messageOrigin;
  const threadTodo = messageOrigin.kind === "agent"
    ? threadTodoMessageOriginFromUnknown(rawThreadTodo)
    : undefined;
  return {
    ...messageOrigin,
    ...(threadTodo ? { threadTodo } : {}),
    sourceThread: {
      backend: sourceThread.backend,
      instanceId: params.sourceInstanceId,
      ...(sourceInstance?.label
        ? { instanceLabel: sourceInstance.label }
        : {}),
      ...(sourceInstance?.celestialIcon
        ? { celestialIcon: sourceInstance.celestialIcon }
        : {}),
      threadId: sourceThread.threadId,
      ...(sourceThread.messageId ? { messageId: sourceThread.messageId } : {}),
      ...(typeof sourceThread.turnId === "string" ? { turnId: sourceThread.turnId } : {}),
      ...(typeof sourceThread.rootTurnId === "string" ? { rootTurnId: sourceThread.rootTurnId } : {}),
      ...(sourceThread.title ? { title: sourceThread.title } : {}),
    },
  };
}

