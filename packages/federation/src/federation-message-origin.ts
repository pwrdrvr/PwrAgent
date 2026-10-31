import type { AppServerThreadMessageOrigin, CelestialIconId } from "@pwragent/shared";
import { isThreadExecutionMode } from "@pwragent/shared";

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
    return params.messageOrigin;
  }

  let sourceInstance: ResolvedSourceInstance | undefined;
  try {
    sourceInstance = params.resolveSourceInstance?.(params.sourceInstanceId);
  } catch {
    // The authenticated instance id remains useful when display metadata is
    // temporarily unavailable. Never fall back to caller-provided identity.
  }

  return {
    ...params.messageOrigin,
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
      // A claim by the peer, like the rest of the agent origin. The owner of
      // the target reads it only to apply its own agent-message access check.
      ...(isThreadExecutionMode(sourceThread.executionMode)
        ? { executionMode: sourceThread.executionMode }
        : {}),
    },
  };
}

