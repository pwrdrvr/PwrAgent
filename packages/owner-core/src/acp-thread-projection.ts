import type { AppServerThreadSummary } from "@pwragent/shared";
import type { AcpSessionMetadata } from "./acp-storage";

export const ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR =
  "This ACP agent cannot hand off a workspace after the first message in a thread. Start a new thread in the target workspace instead.";

export function acpSessionHasConversationHistory(
  session: AcpSessionMetadata,
): boolean {
  return session.hasConversationHistory === true;
}

export function projectAcpSessionThread(
  session: AcpSessionMetadata,
  capabilities: { liveWorkspaceHandoff?: boolean } | undefined,
  directoryLabel: string,
): AppServerThreadSummary {
  const workspaceHandoffAvailable =
    !acpSessionHasConversationHistory(session) ||
    capabilities?.liveWorkspaceHandoff === true;
  return {
    id: session.sessionId,
    title: session.title,
    titleSource:
      session.titleSource ??
      (session.title === "ACP session" ? "fallback" : "derived"),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
    // A failed prompt has settled; an unknown persisted state is not evidence
    // that the session is idle.
    threadStatus: session.status === "active" ? "active"
      : session.status === "unknown" ? "unknown" : "idle",
    linkedDirectories: session.cwd
      ? [
          {
            id: session.cwd,
            label: directoryLabel || session.cwd,
            path: session.cwd,
            kind: "local",
          },
        ]
      : [],
    // The working directory, as Codex reports it: it names which linked
    // directory is the thread's home once `@`-referenced ones join it.
    ...(session.cwd ? { projectKey: session.cwd } : {}),
    source: session.backendId,
    executionMode: session.executionMode,
    acpRuntime: session.acpRuntime,
    workspaceHandoff: workspaceHandoffAvailable
      ? { available: true }
      : {
          available: false,
          unavailableReason: ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR,
        },
  };
}

