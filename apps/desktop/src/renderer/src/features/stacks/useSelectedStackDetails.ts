import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NAVIGATION_QUERY_PROTOCOL_VERSION, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { DesktopApi } from "../../lib/desktop-api";
import { loadSelectedStacks, readCachedSelectedStacks, selectedStackSource, stackOwnerInstanceId } from "./stack-detail-cache";

export function useSelectedStackDetails({ thread, desktopApi, enabled = true, allowLegacyLookup = true }: {
  thread?: NavigationThreadSummary;
  allowLegacyLookup?: boolean;
  enabled?: boolean;
  desktopApi?: Pick<DesktopApi, "getNavigationSelectedDetail" | "getNavigationQueryPage">;
}) {
  const ownerInstanceId = stackOwnerInstanceId(thread);
  const threadId = thread?.id;
  const backend = thread?.source;
  const source = selectedStackSource(thread, ownerInstanceId);
  const [loaded, setLoaded] = useState<{ source: string; stacks?: StackSummary[]; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const read = desktopApi?.getNavigationSelectedDetail;
  const readLegacyRow = desktopApi?.getNavigationQueryPage;
  const needsLegacyLookup = Boolean(allowLegacyLookup && ownerInstanceId && thread?.stackMemberships?.length && !thread?.stacks?.length);
  const hasWorkspace = Boolean(thread?.linkedDirectories.length);
  // A row another reader already loaded at the same revisions draws at once.
  const cached = enabled && read && hasWorkspace ? readCachedSelectedStacks(thread, ownerInstanceId) : undefined;
  const hasCached = Boolean(cached);
  // The read takes the row as rendered; `source` says when that changes.
  const threadRef = useRef(thread);
  useLayoutEffect(() => {
    threadRef.current = thread;
  });
  useEffect(() => {
    const latestThread = threadRef.current;
    if (!enabled || !read || !hasWorkspace || !backend || !threadId || !latestThread || hasCached) return;
    let active = true;
    const ref = { backend, threadId, ownerInstanceId };
    const federationTarget = ownerInstanceId ? { scope: "remote" as const, instanceId: ownerInstanceId } : undefined;
    void loadSelectedStacks(read, latestThread, ownerInstanceId, () => active).then((result) => {
      if (active) setLoaded({ source, ...result });
    }).catch(async (error: unknown) => {
      // A mounted older owner can supply a full stack on one exact row.
      if (!active) return;
      const unsupported = error instanceof Error && error.message.includes("Unknown selected-detail collection");
      if (unsupported && !needsLegacyLookup && allowLegacyLookup) return;
      if (unsupported && readLegacyRow) {
        const legacy = await readLegacyRow({
          protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, consumer: "main-sidebar", federationTarget,
          query: { kind: "exact", identities: [ref] }, pageSize: 1,
        }).catch(() => undefined);
        if (!active) return;
        const row = legacy?.entries.find(({ row }) => row.id === threadId && row.source === backend)?.row;
        if (row?.stacks) {
          setLoaded({ source, stacks: [...new Map(row.stacks.map(({ stack }) => [stack.key, stack])).values()] });
          return;
        }
      }
      setLoaded({ source, error: "Could not load stack details." });
    });
    return () => { active = false; };
  }, [enabled, allowLegacyLookup, read, readLegacyRow, needsLegacyLookup, hasWorkspace, backend, threadId, ownerInstanceId, source, attempt, hasCached]);
  const current = cached ? { stacks: cached, error: undefined } : loaded?.source === source ? loaded : undefined;
  return { stacks: current?.stacks, error: current?.error, retry: () => {
    setLoaded(undefined);
    setAttempt((value) => value + 1);
  } };
}
