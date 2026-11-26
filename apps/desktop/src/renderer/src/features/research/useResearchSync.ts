import { useEffect, useRef, useState } from "react";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { ResearchThread } from "@pwragent/shared/research";
import type { DesktopApi } from "../../lib/desktop-api";
import { ResearchSync, type ResearchSyncState } from "./research-sync";

/**
 * The thread's research, kept current by `ResearchSync`: subscribe before
 * reading, then read only what each change event names. Choosing another run
 * shows no store until that run's first sync finishes.
 */
export function useResearchSync(
  api: DesktopApi | undefined,
  thread: ResearchThread | undefined,
  runId?: string,
  ownerTarget?: FederationRemoteTarget,
): ResearchSyncState & { key: string } {
  const ownerId = ownerTarget?.instanceId;
  const key = thread ? `${ownerId ?? "local"}:${thread.backend}:${thread.threadId}` : "";
  const [held, setHeld] = useState<{ key: string; state: ResearchSyncState }>({ key: "", state: { writableRunIds: [] } });
  const sync = useRef<ResearchSync | undefined>(undefined);
  const researchSnapshot = api?.researchSnapshot;
  const researchChanges = api?.researchChanges;
  const subscribe = api?.onResearchChanged;
  const subscribeAgentEvent = api?.onAgentEvent;
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
    const unsubscribeRecovery = ownerId && subscribeAgentEvent
      ? subscribeAgentEvent((event) => {
          if (event.federationTarget?.scope !== "remote" || event.federationTarget.instanceId !== ownerId) return;
          if (
            event.notification.method === "federation/eventStream/changed"
            || (event.notification.method === "federation/peerStatus/changed" && event.notification.params.status === "connected")
          ) {
            current.resync();
          }
        })
      : undefined;
    current.start();
    return () => {
      current.dispose();
      unsubscribe?.();
      unsubscribeRecovery?.();
      if (sync.current === current) sync.current = undefined;
    };
  }, [backend, threadId, ownerId, researchSnapshot, researchChanges, subscribe, subscribeAgentEvent, key]);
  useEffect(() => { sync.current?.select(runId); }, [runId]);
  return held.key === key ? { ...held.state, key } : { key, writableRunIds: [] };
}
