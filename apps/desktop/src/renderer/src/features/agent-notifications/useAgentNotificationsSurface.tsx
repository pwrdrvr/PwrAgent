import { useCallback, useMemo, type ReactNode } from "react";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { AgentNotificationsButton } from "./AgentNotificationsButton";
import {
  useAgentNotifications,
  type AgentNoticeShowThread,
  type AgentNotificationsApi,
  type AgentNotificationsController,
} from "./useAgentNotifications";

/**
 * The window's agent notices: the durable notice stack, with agent notices
 * placed after approvals and before the other durable notices, and the
 * masthead bell every placement renders. A main window shows this machine's
 * and its connected peers' notices; a peer's window shows that peer's. The
 * stack is merged here so the app shell stays within its bytecode budget.
 */
export function useAgentNotificationsSurface(
  api: AgentNotificationsApi | undefined,
  /** Thread titles by identity key, as the sidebar lists them. */
  threadTitles: ReadonlyMap<string, string>,
  showThread: AgentNoticeShowThread,
  showNotice: (notice: AppNoticeToastNotice) => void,
  approvalNotices: readonly AppNoticeToastNotice[],
  monitorWakeNotices: readonly AppNoticeToastNotice[],
  otherDurableNotices: readonly AppNoticeToastNotice[],
): { durable: AppNoticeToastNotice[]; control: ReactNode } {
  const threadTitle = useCallback(
    (backend: AppServerBackendKind, threadId: string) =>
      threadTitles.get(buildThreadIdentityKey(backend, threadId)) ?? "Untitled thread",
    [threadTitles],
  );
  const controller = useAgentNotifications(api, { threadTitle, showThread, showNotice });
  const control = useMemo(() => <AgentNotificationsButton controller={controller} />, [controller]);
  const notices: AgentNotificationsController["notices"] = controller.notices;
  const durable = useMemo(
    () => [...approvalNotices, ...notices, ...monitorWakeNotices, ...otherDurableNotices],
    [approvalNotices, monitorWakeNotices, notices, otherDurableNotices],
  );
  return { durable, control };
}
