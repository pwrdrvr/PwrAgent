import { useEffect, useState } from "react";
import type { ResearchSnapshot, ResearchThread } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * Subscribe before reading, serialize reads, and repeat when a boundary
 * changed in flight. Each read returns the thread's run summaries and one
 * board, `runId`'s or the newest run's. Choosing another run keeps the
 * previous snapshot on screen until its board arrives.
 */
export function useResearchSnapshot(api: DesktopApi | undefined, thread: ResearchThread | undefined, runId?: string) {
  const key = thread ? `${thread.backend}:${thread.threadId}` : "";
  const [state, setState] = useState<{ key: string; snapshot?: ResearchSnapshot; error?: string }>({ key: "" });
  const read = api?.researchSnapshot;
  const subscribe = api?.onResearchChanged;
  const backend = thread?.backend;
  const threadId = thread?.threadId;
  useEffect(() => {
    if (!backend || !threadId || !read) return;
    let disposed = false;
    let reading = false;
    let dirty = false;
    const refresh = async () => {
      dirty = true;
      if (reading) return;
      reading = true;
      try {
        do {
          dirty = false;
          const snapshot = await read({ backend, threadId, ...(runId ? { runId } : {}) });
          if (!disposed) setState({ key, snapshot });
        } while (dirty && !disposed);
      } catch (error) {
        if (!disposed) setState({ key, error: error instanceof Error ? error.message : "Research could not be read" });
      } finally { reading = false; }
    };
    const unsubscribe = subscribe?.((changed) => {
      if (changed.backend === backend && changed.threadId === threadId) void refresh();
    });
    void refresh();
    return () => { disposed = true; unsubscribe?.(); };
  }, [backend, threadId, runId, read, subscribe, key]);
  return state.key === key ? state : { key };
}
