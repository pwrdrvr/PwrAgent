import type { AppServerThreadSummary } from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import type { InboxReason, ThreadInboxState, ThreadOverlayState } from "@pwragnt/shared";

function isSuppressed(
  overlay: ThreadOverlayState | undefined,
  thread: AppServerThreadSummary,
  now: number,
): boolean {
  if (!overlay) {
    return false;
  }

  if (overlay.snoozedUntil && overlay.snoozedUntil > now) {
    return true;
  }

  if (!overlay.dismissedAt) {
    return false;
  }

  return (thread.updatedAt ?? 0) <= overlay.dismissedAt;
}

export function deriveInboxState(params: {
  firstSnapshot: boolean;
  isNewThread: boolean;
  now?: number;
  overlay?: ThreadOverlayState;
  thread: AppServerThreadSummary;
}): ThreadInboxState {
  const now = params.now ?? Date.now();

  if (isSuppressed(params.overlay, params.thread, now)) {
    return {
      inInbox: false,
      lastSeenAt: params.overlay?.lastSeenAt,
      lastSeenUpdatedAt: params.overlay?.lastSeenUpdatedAt,
    };
  }

  if (params.firstSnapshot) {
    return {
      inInbox: false,
      lastSeenAt: params.overlay?.lastSeenAt,
      lastSeenUpdatedAt: params.overlay?.lastSeenUpdatedAt,
    };
  }

  if (params.isNewThread) {
    return {
      inInbox: true,
      reason: "new-thread",
      lastSeenAt: params.overlay?.lastSeenAt,
      lastSeenUpdatedAt: params.overlay?.lastSeenUpdatedAt,
    };
  }

  const updatedAt = params.thread.updatedAt ?? 0;
  const lastSeenUpdatedAt = params.overlay?.lastSeenUpdatedAt ?? 0;
  const reason: InboxReason | undefined =
    updatedAt > lastSeenUpdatedAt ? "updated-since-seen" : undefined;

  return {
    inInbox: Boolean(reason),
    reason,
    lastSeenAt: params.overlay?.lastSeenAt,
    lastSeenUpdatedAt: params.overlay?.lastSeenUpdatedAt,
  };
}

export function rankInboxThreadKeys(threads: Array<{
  id: string;
  source: AppServerThreadSummary["source"];
  inbox: ThreadInboxState;
  updatedAt?: number;
}>): string[] {
  return threads
    .filter((thread) => thread.inbox.inInbox)
    .sort((left, right) => {
      const reasonWeight = (reason?: InboxReason): number => {
        if (reason === "new-thread") {
          return 2;
        }
        if (reason === "updated-since-seen") {
          return 1;
        }
        return 0;
      };

      const reasonDelta =
        reasonWeight(right.inbox.reason) - reasonWeight(left.inbox.reason);
      if (reasonDelta !== 0) {
        return reasonDelta;
      }

      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    })
    .map((thread) => buildThreadIdentityKey(thread.source, thread.id));
}
