import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSearchQuery, ResearchThread } from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  appendResearchFindingsOlder, emptyResearchFindings, mergeResearchFindingsHead, researchFindingsOlderCursor, type ResearchFindingsWindow,
} from "./research-view-model";
import { researchErrorMessage } from "./research-error";

export const RESEARCH_FINDINGS_PAGE = 20;

/**
 * The unfiltered findings list, read in pages through the indexed item
 * search while it is on screen, newest first. A new finding reads only the
 * first page and goes on top of the loaded window; Show more reads the page
 * below it. Reads run one at a time, so each merge sees the window the
 * previous one left. A filter is matched in the window by the view and reads
 * nothing here.
 */
export function useResearchFindings(api: DesktopApi | undefined, thread: ResearchThread, runId: string, findings: number) {
  const search = api?.searchResearch;
  const { backend, threadId } = thread;
  const key = runId;
  const [loaded, setLoaded] = useState<ResearchFindingsWindow>(() => emptyResearchFindings(key));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(loaded);
  const latest = useRef(key);
  latest.current = key;
  const queue = useRef<Promise<void>>(Promise.resolve());
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
  const commit = useCallback((next: ResearchFindingsWindow) => {
    current.current = next;
    if (live.current) setLoaded(next);
  }, []);
  const read = useCallback(async (cursor?: ResearchSearchQuery["cursor"]) => {
    if (!search) throw new Error("Findings are unavailable in this window");
    return await search({ backend, threadId, runId, query: { type: "finding", limit: RESEARCH_FINDINGS_PAGE, ...(cursor ? { cursor } : {}) } });
  }, [search, backend, threadId, runId]);

  useEffect(() => {
    if (current.current.key !== key) commit(emptyResearchFindings(key));
    if (!search || headQueued.current) return;
    headQueued.current = true;
    void enqueue(async () => {
      headQueued.current = false;
      const wanted = latest.current;
      if (!live.current) return;
      try {
        const page = await read();
        // Another run came on screen while this page was in flight; its own read is queued.
        if (latest.current !== wanted || current.current.key !== wanted) return;
        commit(mergeResearchFindingsHead(current.current, page));
        if (live.current) setError("");
      } catch (failure) {
        if (live.current && latest.current === wanted) setError(researchErrorMessage(failure, "Findings could not be read"));
      }
    });
  }, [key, findings, search, read, enqueue, commit]);

  const showOlder = useCallback(() => {
    if (!search || !current.current.next) return;
    setLoadingOlder(true);
    void enqueue(async () => {
      const wanted = latest.current;
      try {
        let cursor = researchFindingsOlderCursor(current.current);
        if (current.current.key !== wanted || !cursor) return;
        let page;
        try { page = await read(cursor); }
        catch {
          // The board changed since the window's last read. Bring the window up to date, then continue below it.
          const head = await read();
          if (latest.current !== wanted || current.current.key !== wanted) return;
          commit(mergeResearchFindingsHead(current.current, head));
          cursor = researchFindingsOlderCursor(current.current);
          if (!cursor) return;
          page = await read(cursor);
        }
        if (latest.current !== wanted || current.current.key !== wanted) return;
        commit(appendResearchFindingsOlder(current.current, page));
        if (live.current) setError("");
      } catch (failure) {
        if (live.current) setError(researchErrorMessage(failure, "More findings could not be read"));
      } finally {
        if (live.current) setLoadingOlder(false);
      }
    });
  }, [search, read, enqueue, commit]);

  return { loaded: loaded.key === key ? loaded : emptyResearchFindings(key), loadingOlder, error, showOlder, available: Boolean(search) };
}
