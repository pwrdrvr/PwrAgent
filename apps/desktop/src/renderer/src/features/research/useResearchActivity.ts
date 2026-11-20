import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchThread } from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  appendResearchActivityOlder, emptyResearchActivity, mergeResearchActivityHead, researchActivityHeadRange, type ResearchActivityWindow,
} from "./research-view-model";

export const RESEARCH_ACTIVITY_PAGE = 100;

/**
 * Activity reads the journal in pages while it is on screen. A new revision
 * reads only what was appended above the loaded window; Show older reads the
 * page below it. Reads run one at a time, so each merge sees the window the
 * previous one left.
 */
export function useResearchActivity(api: DesktopApi | undefined, thread: ResearchThread, runId: string, revision: number) {
  const read = api?.readResearchEvents;
  const { backend, threadId } = thread;
  const [loaded, setLoaded] = useState<ResearchActivityWindow>(() => emptyResearchActivity(runId));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(loaded);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // A head read waiting in the queue already reads everything above the window when it runs.
  const headQueued = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const enqueue = useCallback((task: () => Promise<void>) => {
    const next = queue.current.then(task, task);
    queue.current = next.catch(() => {});
    return next;
  }, []);
  const commit = useCallback((next: ResearchActivityWindow) => {
    current.current = next;
    if (live.current) setLoaded(next);
  }, []);

  useEffect(() => {
    if (current.current.runId !== runId) commit(emptyResearchActivity(runId));
    if (!read || headQueued.current) return;
    headQueued.current = true;
    void enqueue(async () => {
      headQueued.current = false;
      if (!live.current || current.current.runId !== runId) return;
      try {
        const page = await read({ backend, threadId, runId, range: researchActivityHeadRange(current.current, RESEARCH_ACTIVITY_PAGE) });
        commit(mergeResearchActivityHead(current.current, page));
        if (live.current) setError("");
      } catch (failure) {
        if (live.current) setError(failure instanceof Error ? failure.message : "Activity could not be read");
      }
    });
  }, [backend, threadId, runId, revision, read, enqueue, commit]);

  const showOlder = useCallback(() => {
    const before = current.current.nextBeforeSeq;
    if (!read || before === undefined) return;
    setLoadingOlder(true);
    void enqueue(async () => {
      try {
        const page = await read({ backend, threadId, runId, range: { beforeSeq: before, limit: RESEARCH_ACTIVITY_PAGE } });
        commit(appendResearchActivityOlder(current.current, page));
        if (live.current) setError("");
      } catch (failure) {
        if (live.current) setError(failure instanceof Error ? failure.message : "Older activity could not be read");
      } finally {
        if (live.current) setLoadingOlder(false);
      }
    });
  }, [backend, threadId, runId, read, enqueue, commit]);

  return { loaded: loaded.runId === runId ? loaded : emptyResearchActivity(runId), loadingOlder, error, showOlder, available: Boolean(read) };
}
