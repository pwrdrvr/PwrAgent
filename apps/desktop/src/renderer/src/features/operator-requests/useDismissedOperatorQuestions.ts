import { useEffect, useState } from "react";
import type { OperatorQuestionThreadRequest } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

const EMPTY: readonly string[] = [];

/** Reads owner state on mount and invalidation; never polls during streaming. */
export function useDismissedOperatorQuestions(
  api: DesktopApi | undefined,
  request: OperatorQuestionThreadRequest | undefined,
): readonly string[] {
  const backend = request?.backend;
  const threadId = request?.threadId;
  const owner = request?.federationTarget?.instanceId;
  const key = JSON.stringify([owner, backend, threadId]);
  const [snapshot, setSnapshot] = useState<{ key: string; ids: readonly string[] }>();
  useEffect(() => {
    if (!api?.listDismissedOperatorQuestions || !backend || !threadId) return;
    let disposed = false;
    let loading = false;
    let queued = false;
    const reload = async (): Promise<void> => {
      if (loading) { queued = true; return; }
      loading = true;
      try {
        do {
          queued = false;
          try {
            const ids = await api.listDismissedOperatorQuestions!({ backend, threadId,
              ...(owner ? { federationTarget: { scope: "remote", instanceId: owner } } : {}),
            });
            if (!disposed) setSnapshot({ key, ids });
          } catch (error) {
            if (!disposed) console.warn("Loading dismissed questions failed.", error);
          }
        } while (queued && !disposed);
      } finally { loading = false; }
    };
    const unsubscribe = api.onOperatorRequestsChanged?.((event) => {
      if (event.reason !== "questions") return;
      if (event.federationTarget && event.federationTarget.instanceId !== owner) return;
      if (event.threadId && (event.threadId !== threadId || event.backend !== backend)) return;
      void reload();
    });
    void reload();
    return () => { disposed = true; unsubscribe?.(); };
  }, [api, backend, threadId, owner, key]);
  return snapshot?.key === key ? snapshot.ids : EMPTY;
}
