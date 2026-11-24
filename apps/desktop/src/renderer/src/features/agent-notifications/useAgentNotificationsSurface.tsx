import { useCallback, useMemo, type ReactNode } from "react";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { readRendererFederationTarget } from "../../lib/federation-window";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { AgentNotificationsButton } from "./AgentNotificationsButton";
import {
  useAgentNotifications,
  type AgentNotificationsApi,
  type AgentNotificationsController,
} from "./useAgentNotifications";

/**
 * The window's agent notices: the controller for the notice stack and the
 * masthead bell every placement renders. A window showing a peer has no bell,
 * as the peer's own windows show its notices.
 */
export function useAgentNotificationsSurface(
  api: AgentNotificationsApi | undefined,
  /** Thread titles by identity key, as the sidebar lists them. */
  threadTitles: ReadonlyMap<string, string>,
  showThread: (thread: { backend: AppServerBackendKind; threadId: string }) => void,
  showNotice: (notice: AppNoticeToastNotice) => void,
): { notices: AgentNotificationsController["notices"]; control: ReactNode } {
  const threadTitle = useCallback(
    (backend: AppServerBackendKind, threadId: string) =>
      threadTitles.get(buildThreadIdentityKey(backend, threadId)) ?? "Untitled thread",
    [threadTitles],
  );
  const controller = useAgentNotifications(api, { threadTitle, showThread, showNotice });
  const control = useMemo(
    () => readRendererFederationTarget()
      ? undefined
      : <AgentNotificationsButton controller={controller} threadTitle={threadTitle} />,
    [controller, threadTitle],
  );
  return { notices: controller.notices, control };
}
