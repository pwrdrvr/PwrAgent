import { useEffect, useState } from "react";
import type {
  MessagingChannelKind,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

const ACTIVITY_TAIL_MS = 2_000;

/**
 * Subscribes to per-platform messaging health + activity. Maintains the
 * canonical `MessagingPlatformStatus[]` view: takes the initial snapshot
 * via IPC, then folds incoming events. The list itself only mutates when
 * health changes — activity-driven re-renders go through a separate
 * `activeAtByPlatform` map so the rest of the row doesn't re-render
 * just because a dot flickered.
 */
export function useMessagingPlatformStatuses(
  desktopApi: DesktopApi | undefined,
): {
  statuses: MessagingPlatformStatus[];
  activeAtByPlatform: Record<string, number>;
} {
  const [statuses, setStatuses] = useState<MessagingPlatformStatus[]>([]);
  const [activeAtByPlatform, setActiveAtByPlatform] = useState<
    Record<string, number>
  >({});

  useEffect(() => {
    if (!desktopApi?.getMessagingPlatformStatuses) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const initial = await desktopApi.getMessagingPlatformStatuses!();
        if (cancelled) return;
        setStatuses(initial);
      } catch {
        // Logged in main; ignore in renderer.
      }
    })();

    const unsubscribe = desktopApi.onMessagingPlatformStatusEvent?.(
      (event: MessagingPlatformStatusEvent) => {
        if (event.kind === "activity") {
          setActiveAtByPlatform((current) => ({
            ...current,
            [event.platform]: event.at,
          }));
          return;
        }
        // health-changed
        setStatuses((current) => upsertHealth(current, event));
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  // Sweep stale activity timestamps so the dot stops blinking even if
  // we never receive an "activity end" event (we don't; the runtime
  // only emits per-event, not per-burst).
  useEffect(() => {
    if (Object.keys(activeAtByPlatform).length === 0) {
      return;
    }
    const intervalId = window.setInterval(() => {
      const cutoff = Date.now() - ACTIVITY_TAIL_MS;
      setActiveAtByPlatform((current) => {
        const next: Record<string, number> = {};
        let mutated = false;
        for (const [platform, at] of Object.entries(current)) {
          if (at >= cutoff) {
            next[platform] = at;
          } else {
            mutated = true;
          }
        }
        return mutated ? next : current;
      });
    }, ACTIVITY_TAIL_MS / 2);
    return () => window.clearInterval(intervalId);
  }, [activeAtByPlatform]);

  return { statuses, activeAtByPlatform };
}

function upsertHealth(
  current: MessagingPlatformStatus[],
  event: Extract<MessagingPlatformStatusEvent, { kind: "health-changed" }>,
): MessagingPlatformStatus[] {
  const platform: MessagingChannelKind = event.platform;
  const existing = current.find((entry) => entry.platform === platform);
  const next: MessagingPlatformStatus = {
    ...existing,
    platform,
    health: event.health,
    changedAt: event.at,
    reason: event.reason,
    lastActivityAt: existing?.lastActivityAt,
  };
  if (!existing) {
    return [...current, next];
  }
  return current.map((entry) => (entry.platform === platform ? next : entry));
}
