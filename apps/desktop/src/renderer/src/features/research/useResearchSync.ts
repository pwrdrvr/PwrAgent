import { useEffect, useRef, useState } from "react";
import type { ResearchThread } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { ResearchSync, type ResearchSyncState } from "./research-sync";

/**
 * The thread's research, kept current by `ResearchSync`: subscribe before
 * reading, then read only what each change event names. Choosing another run
 * shows no store until that run's first sync finishes.
 */
export function useResearchSync(api: DesktopApi | undefined, thread: ResearchThread | undefined, runId?: string): ResearchSyncState & { key: string } {
  const key = thread ? `${thread.backend}:${thread.threadId}` : "";
  const [held, setHeld] = useState<{ key: string; state: ResearchSyncState }>({ key: "", state: { writableRunIds: [] } });
  const sync = useRef<ResearchSync | undefined>(undefined);
  const researchSnapshot = api?.researchSnapshot;
  const researchChanges = api?.researchChanges;
  const subscribe = api?.onResearchChanged;
  const backend = thread?.backend;
  const threadId = thread?.threadId;
  const wanted = useRef(runId);
  wanted.current = runId;
  useEffect(() => {
    if (!backend || !threadId || !researchSnapshot || !researchChanges) return;
    const current = new ResearchSync({ researchSnapshot, researchChanges }, { backend, threadId }, (state) => setHeld({ key, state }));
    sync.current = current;
    current.select(wanted.current);
    const unsubscribe = subscribe?.((change) => current.notify(change));
    current.start();
    return () => { current.dispose(); unsubscribe?.(); if (sync.current === current) sync.current = undefined; };
  }, [backend, threadId, researchSnapshot, researchChanges, subscribe, key]);
  useEffect(() => { sync.current?.select(runId); }, [runId]);
  return held.key === key ? { ...held.state, key } : { key, writableRunIds: [] };
}
