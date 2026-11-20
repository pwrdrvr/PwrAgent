import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ResearchProfileRun,
  ResearchProfileRunsPage,
  ResearchProfileRunsQuery,
  ResearchRunAttention,
} from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";
import { researchErrorMessage } from "./useResearchRunActions";

export type ResearchProfileRunsState = {
  /** Undefined until the first page lands. */
  runs?: ResearchProfileRun[];
  writableRunIds: string[];
  counts: Record<ResearchRunAttention, number>;
  /** More runs exist past what is loaded. */
  more: boolean;
  error?: string;
};
const EMPTY: ResearchProfileRunsState = { writableRunIds: [], counts: { needs_you: 0, live: 0, retained: 0 }, more: false };

/**
 * Every run on this profile, a page at a time. The list is read again, as far
 * as it was loaded, whenever the owner reports any research change: a run can
 * move between attention groups, so a patched row could sit in the wrong one.
 * Reads run one at a time, and a change during a read asks for one more.
 */
export function useResearchProfileRuns(api: DesktopApi | undefined, filters: Pick<ResearchProfileRunsQuery, "source" | "text">): ResearchProfileRunsState & { loadMore: () => void } {
  const read = api?.researchProfileRuns;
  const subscribe = api?.onResearchChanged;
  const { source, text } = filters;
  const key = `${source ?? ""}\n${text ?? ""}`;
  const [held, setHeld] = useState<{ key: string; state: ResearchProfileRunsState }>({ key: "", state: EMPTY });
  const pages = useRef(1);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!read) return;
    let disposed = false, reading = false, dirty = false;
    pages.current = 1;
    const load = async () => {
      if (reading) { dirty = true; return; }
      reading = true;
      try {
        do {
          dirty = false;
          const wanted = pages.current;
          const runs: ResearchProfileRun[] = [];
          const writable: string[] = [];
          let page: ResearchProfileRunsPage | undefined;
          for (let index = 0; index < wanted; index++) {
            page = await read({ ...(source ? { source } : {}), ...(text ? { text } : {}), ...(page?.nextCursor ? { after: page.nextCursor } : {}) });
            if (disposed) return;
            // A run that changed group between two page reads may be returned twice; the first read wins.
            for (const run of page.runs) if (!runs.some((seen) => seen.id === run.id)) runs.push(run);
            writable.push(...page.writableRunIds);
            if (!page.nextCursor) break;
          }
          if (page) setHeld({ key, state: { runs, writableRunIds: writable, counts: page.counts, more: Boolean(page.nextCursor) } });
        } while (dirty && !disposed);
      } catch (failure) {
        if (!disposed) setHeld((current) => ({ key, state: { ...(current.key === key ? current.state : EMPTY), error: researchErrorMessage(failure) } }));
      } finally { reading = false; }
    };
    refresh.current = () => { void load(); };
    const unsubscribe = subscribe?.(() => { void load(); });
    void load();
    return () => { disposed = true; unsubscribe?.(); };
  }, [read, subscribe, source, text, key]);
  const loadMore = useCallback(() => { pages.current += 1; refresh.current(); }, []);
  return { ...(held.key === key ? held.state : EMPTY), loadMore };
}
