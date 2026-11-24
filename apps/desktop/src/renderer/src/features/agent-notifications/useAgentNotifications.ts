import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  AgentNotificationItem,
  AgentNotificationsSnapshot,
  ManageAgentNotificationsRequest,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { DesktopApi } from "../../lib/desktop-api";
import { openExternalUrl } from "../../lib/open-external-url";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";

const EMPTY: AgentNotificationsSnapshot = { unread: [], scheduled: [], earlier: [] };
export const AGENT_NOTICE_PREFIX = "agent-notice:";
const AGENT_NOTICE_GROUP = "agent-notices";

export type AgentNotificationsApi = Pick<DesktopApi, "manageAgentNotifications" | "onAgentEvent" | "openMarkdownFileViewer">;

export type AgentNotificationsController = {
  snapshot: AgentNotificationsSnapshot;
  /** Durable notice cards, one per unread notice, newest first. */
  notices: AppNoticeToastNotice[];
  open: (item: AgentNotificationItem) => void;
  openThread: (item: AgentNotificationItem) => void;
  dismiss: (id: string) => void;
  dismissAll: () => void;
  cancel: (id: string) => void;
};

/**
 * The owner's agent notices for this window. The owner keeps read state;
 * a window only asks for the snapshot again when the owner says it changed.
 */
export function useAgentNotifications(
  api: AgentNotificationsApi | undefined,
  options: {
    threadTitle: (backend: AppServerBackendKind, threadId: string) => string;
    showThread: (thread: { backend: AppServerBackendKind; threadId: string }) => void;
    showNotice: (notice: AppNoticeToastNotice) => void;
  },
): AgentNotificationsController {
  const [snapshot, setSnapshot] = useState<AgentNotificationsSnapshot>(EMPTY);
  const reads = useRef({ revision: 0 });
  const manage = api?.manageAgentNotifications;
  const subscribe = api?.onAgentEvent;
  const openFile = api?.openMarkdownFileViewer;
  const { threadTitle, showThread, showNotice } = options;

  const run = useCallback(async (request: ManageAgentNotificationsRequest) => {
    if (!manage) return;
    const reading = ++reads.current.revision;
    try {
      const result = await manage(request);
      if (!result.ok) {
        if (request.action !== "snapshot") {
          showNotice({ id: `${AGENT_NOTICE_PREFIX}error`, title: "Could not update the notice", message: result.error.message, tone: "error" });
        }
        return;
      }
      if (reading === reads.current.revision) setSnapshot(result.snapshot);
    } catch (error) {
      if (request.action !== "snapshot") {
        showNotice({ id: `${AGENT_NOTICE_PREFIX}error`, title: "Could not update the notice", message: String(error), tone: "error" });
      }
    }
  }, [manage, showNotice]);

  useEffect(() => {
    const requests = reads.current;
    const reload = () => { void run({ action: "snapshot" }); };
    const unsubscribe = subscribe?.((event) => {
      // A peer's notices belong to the peer's own windows.
      if (event.federationTarget?.scope === "remote") return;
      const method = event.notification.method;
      if (method === "agentNotifications/updated"
        || (method === "thread/scheduledAction/updated"
          && (event.notification.params as { action?: { kind?: unknown } }).action?.kind === "notification")) {
        reload();
      }
    });
    reload();
    return () => {
      requests.revision++;
      unsubscribe?.();
    };
  }, [run, subscribe]);

  const dismiss = useCallback((id: string) => { void run({ action: "dismiss", id }); }, [run]);
  const dismissAll = useCallback(() => { void run({ action: "dismiss_all" }); }, [run]);
  const cancel = useCallback((id: string) => { void run({ action: "cancel", id }); }, [run]);
  const openThread = useCallback((item: AgentNotificationItem) => {
    showThread({ backend: item.backend, threadId: item.threadId });
    dismiss(item.id);
  }, [dismiss, showThread]);
  const open = useCallback((item: AgentNotificationItem) => {
    const link = item.link;
    if (link?.kind === "url") {
      openExternalUrl(link.url);
    } else if (link?.kind === "file" && openFile) {
      const title = threadTitle(item.backend, item.threadId);
      void openFile({
        context: {
          key: `${AGENT_NOTICE_PREFIX}${buildThreadIdentityKey(item.backend, item.threadId)}`,
          thread: { backend: item.backend, threadId: item.threadId },
          title,
          threadTitle: title,
        },
        file: { path: link.path, label: link.path.split(/[\\/]/).filter(Boolean).pop() ?? link.path },
      }).catch((error: unknown) => {
        showNotice({ id: `${AGENT_NOTICE_PREFIX}error`, title: "Could not open the file", message: String(error), tone: "error" });
      });
    } else {
      showThread({ backend: item.backend, threadId: item.threadId });
    }
    dismiss(item.id);
  }, [dismiss, openFile, showNotice, showThread, threadTitle]);

  const notices = useMemo(() => snapshot.unread.map((item) => buildAgentNotice(item, {
    threadTitle: threadTitle(item.backend, item.threadId),
    onOpen: () => open(item),
    onOpenThread: () => openThread(item),
    onDismiss: () => dismiss(item.id),
    onDismissAll: dismissAll,
  })), [dismiss, dismissAll, open, openThread, snapshot.unread, threadTitle]);

  return { snapshot, notices, open, openThread, dismiss, dismissAll, cancel };
}

/** One unread notice as a durable card in the notice stack. */
export function buildAgentNotice(
  item: AgentNotificationItem,
  handlers: {
    threadTitle: string;
    onOpen: () => void;
    onOpenThread: () => void;
    onDismiss: () => void;
    onDismissAll: () => void;
  },
): AppNoticeToastNotice {
  const linkLabel = item.link?.kind === "url" ? "Open link" : item.link?.kind === "file" ? "Open file" : undefined;
  const facts: { label: string; value: string }[] = [];
  if (item.link?.kind === "url") facts.push({ label: "Link", value: item.link.url });
  if (item.link?.kind === "file") facts.push({ label: "File", value: item.link.path });
  return {
    id: `${AGENT_NOTICE_PREFIX}${item.id}`,
    title: item.title,
    message: item.body,
    tone: item.urgency === "high" ? "warning" : "neutral",
    autoDismiss: false,
    threadLink: { backend: item.backend, threadId: item.threadId, title: handlers.threadTitle },
    ...(facts.length > 0 ? { facts } : {}),
    dismissLabel: "Dismiss notification",
    onDismiss: handlers.onDismiss,
    dismissGroup: { key: AGENT_NOTICE_GROUP, label: "Dismiss all notifications", actionLabel: "Dismiss all", onDismissAll: handlers.onDismissAll },
    actions: linkLabel
      ? [
          { label: linkLabel, onClick: handlers.onOpen },
          { label: "Open thread", onClick: handlers.onOpenThread, tone: "secondary" },
        ]
      : [{ label: "Open thread", onClick: handlers.onOpenThread }],
  };
}
