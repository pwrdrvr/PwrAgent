import {
  AGENT_NOTIFICATION_WINDOW_MS,
  type AgentNotificationItem,
  type AgentNotificationsSnapshot,
  type ScheduledThreadAction,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";

const NATIVE_BODY_MAX_CHARS = 220;
/** Unread notices one process keeps; the oldest drop out of the stack. */
const MAX_UNREAD = 100;
const SNAPSHOT_LIMIT = 100;

export type AgentNotificationCenterDependencies = {
  now?: () => number;
  /** Notices waiting and those delivered since a time, from the scheduler. */
  listNotices: (request: { deliveredSince: number; limit: number }) => ScheduledThreadAction[];
  /** The operator's Desktop notifications switch. */
  nativeNotificationsEnabled: () => boolean;
  notifyNative: (params: { enabled: boolean; key: string; title: string; body: string; onShow?: () => void }) => void;
  clearNative: (key: string) => void;
  showThread: (thread: { backend: AppServerBackendKind; threadId: string }) => void;
  threadLabel: (backend: AppServerBackendKind, threadId: string) => Promise<string | undefined>;
  /** Tells the owner's windows to read the snapshot again. */
  publishChanged: (thread: { backend: AppServerBackendKind; threadId: string }) => Promise<void> | void;
};

/**
 * Where an agent's notices meet the operator on this owner. The scheduler
 * decides when a notice is due and records that it was delivered; this keeps
 * which delivered notices the operator has not dismissed. That read state is
 * the process's own and writes nothing, so a restart clears it and the
 * notice moves to Earlier.
 *
 * Native eligibility and dedup stay in the desktop notification service:
 * one key per notice, shown only when notifications are on and no window is
 * focused.
 */
export class AgentNotificationCenter {
  private readonly unread = new Map<string, AgentNotificationItem>();
  private readonly now: () => number;

  constructor(private readonly deps: AgentNotificationCenterDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /** Called by the scheduler with a claimed notice that came due. */
  async deliver(action: ScheduledThreadAction): Promise<void> {
    const item = itemFromAction(action, this.now());
    if (!item || this.unread.has(item.id)) return;
    this.unread.set(item.id, item);
    while (this.unread.size > MAX_UNREAD) {
      const oldest = this.unread.keys().next().value!;
      this.unread.delete(oldest);
      this.deps.clearNative(nativeKey(oldest));
    }
    const label = await this.deps.threadLabel(item.backend, item.threadId).catch(() => undefined);
    const body = clip(label ? `${label} · ${item.body}` : item.body, NATIVE_BODY_MAX_CHARS);
    this.deps.notifyNative({
      enabled: this.deps.nativeNotificationsEnabled(),
      key: nativeKey(item.id),
      title: item.title,
      body,
      onShow: () => {
        this.deps.showThread({ backend: item.backend, threadId: item.threadId });
        void this.dismiss(item.id);
      },
    });
    // Shown already: a failed refresh must not make the scheduler record a
    // delivered notice as failed. Windows re-read on the delivered event.
    await Promise.resolve(this.deps.publishChanged({ backend: item.backend, threadId: item.threadId }))
      .catch(() => undefined);
  }

  /** Marks a notice read in every window of this owner. */
  async dismiss(id: string): Promise<boolean> {
    const item = this.unread.get(id);
    if (!item) return false;
    this.unread.delete(id);
    this.deps.clearNative(nativeKey(id));
    await this.deps.publishChanged({ backend: item.backend, threadId: item.threadId });
    return true;
  }

  /** Dismisses the listed notices, or every unread one when none are listed. */
  async dismissAll(ids?: readonly string[]): Promise<number> {
    const listed = ids ? new Set(ids) : undefined;
    const items = [...this.unread.values()].filter((item) => !listed || listed.has(item.id));
    for (const item of items) {
      this.unread.delete(item.id);
      this.deps.clearNative(nativeKey(item.id));
    }
    const last = items.at(-1);
    if (last) await this.deps.publishChanged({ backend: last.backend, threadId: last.threadId });
    return items.length;
  }

  /**
   * The snapshot with each thread's title, for a peer's windows, which do
   * not list this owner's threads. One lookup per thread.
   */
  async titledSnapshot(): Promise<AgentNotificationsSnapshot> {
    const snapshot = this.snapshot();
    const titles = new Map<string, Promise<string | undefined>>();
    const title = (item: AgentNotificationItem) => {
      const key = `${item.backend}\0${item.threadId}`;
      let pending = titles.get(key);
      if (!pending) {
        pending = this.deps.threadLabel(item.backend, item.threadId).catch(() => undefined);
        titles.set(key, pending);
      }
      return pending;
    };
    const titled = (items: AgentNotificationItem[]) => Promise.all(items.map(async (item) => {
      const threadTitle = await title(item);
      return threadTitle ? { ...item, threadTitle } : item;
    }));
    const [unread, scheduled, earlier] = await Promise.all([
      titled(snapshot.unread), titled(snapshot.scheduled), titled(snapshot.earlier),
    ]);
    return { unread, scheduled, earlier };
  }

  snapshot(): AgentNotificationsSnapshot {
    const now = this.now();
    const scheduled: AgentNotificationItem[] = [];
    const earlier: AgentNotificationItem[] = [];
    for (const action of this.deps.listNotices({ deliveredSince: now - AGENT_NOTIFICATION_WINDOW_MS, limit: SNAPSHOT_LIMIT })) {
      const item = itemFromAction(action, now);
      // An unread notice is listed once, as unread, even mid-delivery.
      if (!item || this.unread.has(item.id)) continue;
      if (action.status === "started") {
        earlier.push(item);
      } else {
        scheduled.push(item);
      }
    }
    scheduled.sort((left, right) => left.scheduledFor - right.scheduledFor);
    return {
      // Newest first, the order the stack pages through.
      unread: [...this.unread.values()].reverse(),
      scheduled,
      earlier,
    };
  }
}

function nativeKey(id: string): string {
  return `agent-notification:${id}`;
}

function itemFromAction(action: ScheduledThreadAction, now: number): AgentNotificationItem | undefined {
  const notice = action.notification;
  if (action.kind !== "notification" || !notice) return undefined;
  return {
    id: action.id,
    backend: action.backend,
    threadId: action.threadId,
    title: notice.title,
    body: notice.body,
    urgency: notice.urgency,
    ...(notice.link ? { link: notice.link } : {}),
    status: action.status,
    scheduledFor: action.scheduledFor,
    ...(action.status === "started" ? { deliveredAt: action.updatedAt }
      : action.status === "dispatching" ? { deliveredAt: now } : {}),
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
