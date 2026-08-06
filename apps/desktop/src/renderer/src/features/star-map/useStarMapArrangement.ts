import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isStarMapArrangementEntry,
  starMapArrangementEntryKey,
  type StarMapArrangementEntry,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

export type StarMapCardOffset = { dx: number; dy: number };

/**
 * The synced card arrangement: seeded from the overlay store, kept live by
 * `starMap/arrangement/changed` agent events (fired for local writes and
 * for deltas merged off the federation), written back through
 * setStarMapCardPosition. Writes are optimistic — the durable merge is
 * last-writer-wins, and a losing write converges on the next event.
 */
export function useStarMapArrangement(params: {
  desktopApi?: DesktopApi;
}): {
  offsetFor: (
    instanceId: string,
    threadKey: string,
  ) => StarMapCardOffset | undefined;
  setCardPosition: (
    instanceId: string,
    threadKey: string,
    offset: StarMapCardOffset | null,
  ) => void;
} {
  const desktopApi = params.desktopApi;
  const [entries, setEntries] = useState<
    Map<string, StarMapArrangementEntry>
  >(new Map());

  useEffect(() => {
    let cancelled = false;
    void desktopApi
      ?.readStarMapArrangement?.()
      .then((response) => {
        if (cancelled) return;
        setEntries(
          new Map(
            response.entries.map((entry) => [
              starMapArrangementEntryKey(entry),
              entry,
            ]),
          ),
        );
      })
      .catch(() => {
        // The arrangement is cosmetic; default slots are always correct.
      });
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method !== "starMap/arrangement/changed") {
        return;
      }
      const params = event.notification.params as { entries?: unknown[] };
      if (!Array.isArray(params.entries)) return;
      const incoming = params.entries.filter(isStarMapArrangementEntry);
      if (incoming.length === 0) return;
      setEntries((current) => {
        const next = new Map(current);
        for (const entry of incoming) {
          next.set(starMapArrangementEntryKey(entry), entry);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  const setCardPosition = useCallback(
    (
      instanceId: string,
      threadKey: string,
      offset: StarMapCardOffset | null,
    ) => {
      const optimistic: StarMapArrangementEntry = {
        instanceId,
        threadKey,
        dx: offset?.dx ?? null,
        dy: offset?.dy ?? null,
        updatedAt: Date.now(),
        by: "local-optimistic",
      };
      setEntries((current) => {
        const next = new Map(current);
        next.set(starMapArrangementEntryKey(optimistic), optimistic);
        return next;
      });
      void desktopApi
        ?.setStarMapCardPosition?.({
          instanceId,
          threadKey,
          dx: offset?.dx ?? null,
          dy: offset?.dy ?? null,
        })
        .catch(() => {
          // The durable write failed; the next snapshot read reconverges.
        });
    },
    [desktopApi],
  );

  const offsetFor = useMemo(() => {
    return (instanceId: string, threadKey: string) => {
      const entry = entries.get(
        starMapArrangementEntryKey({ instanceId, threadKey }),
      );
      if (!entry || entry.dx === null || entry.dy === null) return undefined;
      return { dx: entry.dx, dy: entry.dy };
    };
  }, [entries]);

  return { offsetFor, setCardPosition };
}
