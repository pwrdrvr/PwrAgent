import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchSearchQuery, ResearchThread } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  appendResearchFindingsOlder, emptyResearchFindings, mergeResearchFindingsHead, researchFindingsOlderCursor, type ResearchFindingsWindow,
} from "./research-view-model";

export const RESEARCH_FINDINGS_PAGE = 20;
const FILTER_DELAY_MS = 150;

/**
 * Findings are read in pages through the indexed item search while they are
 * on screen, newest first. A new finding reads only the first page and goes
 * on top of the loaded window; Show more reads the page below it. The filter
 * is the search's own text match, so it covers every finding, loaded or not.
 * Reads run one at a time, so each merge sees the window the previous one left.
 */
export function useResearchFindings(api: DesktopApi | undefined, thread: ResearchThread, runId: string, findings: number, filter: string) {
  const search = api?.searchResearch;
  const { backend, threadId } = thread;
  const [text, setText] = useState(() => filter.trim());
  useEffect(() => {
    const next = filter.trim();
    if (next === text) return;
    const timer = window.setTimeout(() => setText(next), FILTER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [filter, text]);
  const key = JSON.stringify([runId, text]);
  const [loaded, setLoaded] = useState<ResearchFindingsWindow>(() => emptyResearchFindings(key));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(loaded);
  const latest = useRef({ key, text });
  latest.current = { key, text };
  const queue = useRef<Promise<void>>(Promise.resolve());
  // A head read waiting in the queue reads whatever the filter is when it runs.
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
  const read = useCallback(async (query: string, cursor?: ResearchSearchQuery["cursor"]) => {
    if (!search) throw new Error("Findings are unavailable in this window");
    return await search({ backend, threadId, runId, query: { type: "finding", query: query || undefined, limit: RESEARCH_FINDINGS_PAGE, ...(cursor ? { cursor } : {}) } });
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
        const page = await read(wanted.text);
        // The filter changed while this page was in flight; its own read is queued.
        if (latest.current.key !== wanted.key || current.current.key !== wanted.key) return;
        commit(mergeResearchFindingsHead(current.current, page));
        if (live.current) setError("");
      } catch (failure) {
        if (live.current && latest.current.key === wanted.key) setError(failure instanceof Error ? failure.message : "Findings could not be read");
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
        if (current.current.key !== wanted.key || !cursor) return;
        let page;
        try { page = await read(wanted.text, cursor); }
        catch {
          // The board changed since the window's last read. Bring the window up to date, then continue below it.
          const head = await read(wanted.text);
          if (latest.current.key !== wanted.key || current.current.key !== wanted.key) return;
          commit(mergeResearchFindingsHead(current.current, head));
          cursor = researchFindingsOlderCursor(current.current);
          if (!cursor) return;
          page = await read(wanted.text, cursor);
        }
        if (latest.current.key !== wanted.key || current.current.key !== wanted.key) return;
        commit(appendResearchFindingsOlder(current.current, page));
        if (live.current) setError("");
      } catch (failure) {
        if (live.current) setError(failure instanceof Error ? failure.message : "More findings could not be read");
      } finally {
        if (live.current) setLoadingOlder(false);
      }
    });
  }, [search, read, enqueue, commit]);

  return { loaded: loaded.key === key ? loaded : emptyResearchFindings(key), filtered: Boolean(text), loadingOlder, error, showOlder, available: Boolean(search) };
}
