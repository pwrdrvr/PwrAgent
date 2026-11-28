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

export type AgentNotificationsApi = Pick<
  DesktopApi,
  "manageAgentNotifications" | "onAgentEvent" | "onAgentNotificationsChanged" | "openMarkdownFileViewer"
>;

/** Opens a notice's thread, on a peer when the notice is a peer's. */
export type AgentNoticeShowThread = (thread: {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: string;
  instanceLabel?: string;
}) => void;

export type AgentNotificationsController = {
  snapshot: AgentNotificationsSnapshot;
  /** Durable notice cards, one per unread notice, newest first. */
  notices: AppNoticeToastNotice[];
  open: (item: AgentNotificationItem) => void;
  openThread: (item: AgentNotificationItem) => void;
  dismiss: (item: AgentNotificationItem) => void;
  dismissAll: () => void;
  cancel: (item: AgentNotificationItem) => void;
  /** The thread a notice came from, named for this window. */
  threadTitle: (item: AgentNotificationItem) => string;
};

/** A peer's notice ids are the peer's own, so the key names the peer too. */
export function agentNoticeKey(item: AgentNotificationItem): string {
  return item.federationTarget ? `${item.federationTarget.instanceId}:${item.id}` : item.id;
}

/**
 * The agent notices this window shows: a main window this machine's and its
 * connected peers', a peer's window that peer's. Each owner keeps read
 * state; a window asks for the snapshot again when an owner says it changed.
 */
export function useAgentNotifications(
  api: AgentNotificationsApi | undefined,
  options: {
    /** A title for one of this window's own threads. */
    threadTitle: (backend: AppServerBackendKind, threadId: string) => string;
    showThread: AgentNoticeShowThread;
    showNotice: (notice: AppNoticeToastNotice) => void;
  },
): AgentNotificationsController {
  const [snapshot, setSnapshot] = useState<AgentNotificationsSnapshot>(EMPTY);
  const reads = useRef({ revision: 0 });
  const manage = api?.manageAgentNotifications;
  const subscribe = api?.onAgentEvent;
  const subscribePeers = api?.onAgentNotificationsChanged;
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
    // This machine's main process follows its peers' notices and says when
    // they change; a peer's own events are not read here.
    const unsubscribePeers = subscribePeers?.(reload);
    const unsubscribe = subscribe?.((event) => {
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
      unsubscribePeers?.();
    };
  }, [run, subscribe, subscribePeers]);

  const dismiss = useCallback((item: AgentNotificationItem) => {
    void run({ action: "dismiss", id: item.id, ...owner(item) });
  }, [run]);
  const dismissAll = useCallback(() => { void run({ action: "dismiss_all" }); }, [run]);
  const cancel = useCallback((item: AgentNotificationItem) => {
    void run({ action: "cancel", id: item.id, ...owner(item) });
  }, [run]);
  const noticeThreadTitle = useCallback((item: AgentNotificationItem) => item.federationTarget
    ? `${item.threadTitle ?? "Untitled thread"} on ${item.ownerLabel ?? "another machine"}`
    : threadTitle(item.backend, item.threadId), [threadTitle]);
  const show = useCallback((item: AgentNotificationItem) => {
    showThread({
      backend: item.backend,
      threadId: item.threadId,
      ...(item.federationTarget
        ? { instanceId: item.federationTarget.instanceId, ...(item.ownerLabel ? { instanceLabel: item.ownerLabel } : {}) }
        : {}),
    });
  }, [showThread]);
  const openThread = useCallback((item: AgentNotificationItem) => {
    show(item);
    dismiss(item);
  }, [dismiss, show]);
  const open = useCallback((item: AgentNotificationItem) => {
    const link = item.link;
    if (link?.kind === "url") {
      openExternalUrl(link.url);
    } else if (link?.kind === "file" && openFile) {
      const title = noticeThreadTitle(item);
      void openFile({
        context: {
          // A peer's file is read from the peer.
          ...(item.federationTarget ? { federationTarget: item.federationTarget } : {}),
          key: `${AGENT_NOTICE_PREFIX}${item.federationTarget ? `${item.federationTarget.instanceId}:` : ""}${buildThreadIdentityKey(item.backend, item.threadId)}`,
          thread: { backend: item.backend, threadId: item.threadId },
          title,
          threadTitle: title,
        },
        file: { path: link.path, label: link.path.split(/[\\/]/).filter(Boolean).pop() ?? link.path },
      }).catch((error: unknown) => {
        showNotice({ id: `${AGENT_NOTICE_PREFIX}error`, title: "Could not open the file", message: String(error), tone: "error" });
      });
    } else {
      show(item);
    }
    dismiss(item);
  }, [dismiss, noticeThreadTitle, openFile, show, showNotice]);

  const notices = useMemo(() => snapshot.unread.map((item) => buildAgentNotice(item, {
    threadTitle: noticeThreadTitle(item),
    onOpen: () => open(item),
    onOpenThread: () => openThread(item),
    onDismiss: () => dismiss(item),
    onDismissAll: dismissAll,
  })), [dismiss, dismissAll, noticeThreadTitle, open, openThread, snapshot.unread]);

  return { snapshot, notices, open, openThread, dismiss, dismissAll, cancel, threadTitle: noticeThreadTitle };
}

function owner(item: AgentNotificationItem): { federationTarget?: AgentNotificationItem["federationTarget"] } {
  return item.federationTarget ? { federationTarget: item.federationTarget } : {};
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
    id: `${AGENT_NOTICE_PREFIX}${agentNoticeKey(item)}`,
    title: item.title,
    message: item.body,
    tone: item.urgency === "high" ? "warning" : "neutral",
    autoDismiss: false,
    threadLink: {
      backend: item.backend,
      threadId: item.threadId,
      title: handlers.threadTitle,
      ...(item.federationTarget
        ? { instanceId: item.federationTarget.instanceId, ...(item.ownerLabel ? { instanceLabel: item.ownerLabel } : {}) }
        : {}),
    },
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
