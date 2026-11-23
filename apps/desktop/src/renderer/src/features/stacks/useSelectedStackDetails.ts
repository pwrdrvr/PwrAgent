import { useEffect, useState } from "react";
import { NAVIGATION_QUERY_PROTOCOL_VERSION, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { StackSummary } from "@pwragent/shared/stacks/stack-status";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

export function useSelectedStackDetails({ thread, desktopApi, enabled = true, allowLegacyLookup = true }: {
  thread?: NavigationThreadSummary;
  allowLegacyLookup?: boolean;
  enabled?: boolean;
  desktopApi?: Pick<DesktopApi, "getNavigationSelectedDetail" | "getNavigationQueryPage">;
}) {
  const target = thread?.federation?.ref.target ?? readRendererFederationTarget();
  const ownerInstanceId = target?.scope === "remote" ? target.instanceId : undefined;
  const threadId = thread?.id;
  const backend = thread?.source;
  const source = JSON.stringify([backend, threadId, ownerInstanceId, thread?.stackMemberships,
    thread?.observedGitBranch, thread?.prs?.map(({ number, baseRefName, headSha, lifecycleState }) =>
      [number, baseRefName, headSha, lifecycleState])]);
  const [loaded, setLoaded] = useState<{ source: string; stacks?: StackSummary[]; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const read = desktopApi?.getNavigationSelectedDetail;
  const readLegacyRow = desktopApi?.getNavigationQueryPage;
  const needsLegacyLookup = Boolean(allowLegacyLookup && ownerInstanceId && thread?.stackMemberships?.length && !thread?.stacks?.length);
  const hasWorkspace = Boolean(thread?.linkedDirectories.length);
  useEffect(() => {
    if (!enabled || !read || !hasWorkspace || !backend || !threadId) return;
    let active = true;
    const ref = { backend, threadId, ownerInstanceId };
    const federationTarget = ownerInstanceId ? { scope: "remote" as const, instanceId: ownerInstanceId } : undefined;
    void (async () => {
      const stacks = new Map<string, StackSummary>();
      const cursors = new Set<string>();
      let revision: string | undefined;
      let cursor: string | undefined;
      let bytes = 0;
      do {
        const result = await read({
          protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, ref, federationTarget,
          collection: { name: "stackLayers", cursor },
        });
        if (!active) return;
        const page = result.collectionPage;
        if (result.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION || result.readiness !== "ready"
          || result.ref.backend !== backend || result.ref.threadId !== threadId || result.ref.ownerInstanceId !== ownerInstanceId
          || page?.name !== "stackLayers" || (revision !== undefined && page.revision !== revision)) {
          throw new Error("Stack details changed while loading.");
        }
        revision = page.revision;
        const layers = page.values.stackLayers ?? [];
        bytes += new TextEncoder().encode(JSON.stringify(layers)).byteLength;
        if (bytes > 8 * 1024 * 1024) {
          setLoaded({ source, error: "Stack details exceed the display limit." });
          return;
        }
        for (const { stackKey, stack, layer, position } of layers) {
          const current = stacks.get(stackKey) ?? (stack?.key === stackKey ? { ...stack, layers: [] } : undefined);
          if (!current || position !== current.layers.length + 1) throw new Error("Stack details arrived out of order.");
          current.layers.push(layer);
          stacks.set(stackKey, current);
        }
        if (page.complete) {
          setLoaded({ source, stacks: [...stacks.values()] });
          return;
        }
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor) || !layers.length) throw new Error("Stack details did not finish loading.");
        cursors.add(cursor);
      } while (active);
    })().catch(async (error: unknown) => {
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
  }, [enabled, allowLegacyLookup, read, readLegacyRow, needsLegacyLookup, hasWorkspace, backend, threadId, ownerInstanceId, source, attempt]);
  const current = loaded?.source === source ? loaded : undefined;
  return { stacks: current?.stacks, error: current?.error, retry: () => {
    setLoaded(undefined);
    setAttempt((value) => value + 1);
  } };
}
