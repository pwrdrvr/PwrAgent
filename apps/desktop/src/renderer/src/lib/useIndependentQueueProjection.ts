import { buildOwnedComposerScopeKey } from "@pwragent/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComposerThreadOwner,
  FederationTarget,
  NavigationQueueProjection,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadComposerScopeKey,
  type ComposerDraftStore,
} from "../features/composer/useComposerDraftStore";
import { resolveComposerScopeOwner } from "../features/composer/useOwnedComposerDraftStore";
import type { DesktopApi } from "./desktop-api";
import { readCompleteNavigationQueue, reconcileCompleteNavigationQueue } from "./navigation-queue-projection";

export type SelectedQueueReadiness = {
  ownerKey?: string;
  readiness: "loading" | "ready" | "failed";
  projection?: NavigationQueueProjection;
  error?: string;
};

/** Complete FIFO reads follow local scope identities, independently of navigation pages. */
export function useIndependentQueueProjection(params: {
  composerDraftStore?: ComposerDraftStore;
  desktopApi?: DesktopApi;
  selectedThread?: NavigationThreadSummary;
  federationTarget?: FederationTarget;
}): SelectedQueueReadiness & { refresh: () => Promise<void> } {
  const { desktopApi, composerDraftStore } = params;
  const current = useRef(params);
  current.current = params;
  const selected = params.selectedThread;
  const selectedOwner: ComposerThreadOwner | undefined = selected ? {
    backend: selected.source,
    threadId: selected.id,
    target: selected.federation?.ref.target ?? params.federationTarget ?? { scope: "local" },
  } : undefined;
  const selectedKey = selectedOwner ? buildOwnedComposerScopeKey(selectedOwner) : undefined;
  const [selectedState, setSelectedState] = useState<SelectedQueueReadiness>({ readiness: "loading" });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshSelected = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!desktopApi?.getNavigationQueueProjection) {
      setSelectedState({ ownerKey: selectedKey, readiness: "failed",
        error: "Desktop bridge is missing independent queue support. Upgrade this instance." });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;
    const baselines = new Map<string, NavigationQueueProjection>();

    const refresh = async (): Promise<void> => {
      if (running) { dirty = true; return; }
      running = true;
      try {
        const demands = new Map<string, { owner: ComposerThreadOwner; scopes: Set<string> }>();
        for (const scope of composerDraftStore?.getQueuedScopeKeys() ?? []) {
          const resolved = resolveComposerScopeOwner(composerDraftStore!, scope);
          if (resolved.state !== "known") continue;
          const key = buildOwnedComposerScopeKey(resolved.owner);
          const demand = demands.get(key) ?? { owner: resolved.owner, scopes: new Set<string>() };
          demand.scopes.add(scope);
          demands.set(key, demand);
        }
        const selected = current.current.selectedThread;
        if (selected) {
          const owner: ComposerThreadOwner = {
            backend: selected.source, threadId: selected.id,
            target: selected.federation?.ref.target ?? current.current.federationTarget ?? { scope: "local" },
          };
          const key = buildOwnedComposerScopeKey(owner);
          const demand = demands.get(key) ?? { owner, scopes: new Set<string>() };
          const scope = buildThreadComposerScopeKey(selected.source, selected.id, owner.target);
          const resolved = composerDraftStore ? resolveComposerScopeOwner(composerDraftStore, scope) : undefined;
          // Selection authorizes an exact read, never ownership of ambiguous or legacy local drafts.
          if (resolved?.state === "known" && buildOwnedComposerScopeKey(resolved.owner) === key) demand.scopes.add(scope);
          demands.set(key, demand);
        }
        const pending = [...demands];
        await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
          while (!cancelled) {
            const demand = pending.shift();
            if (!demand) return;
            const [baselineKey, { owner, scopes }] = demand;
            const captured = new Map([...scopes].map((scope) => [scope, composerDraftStore!.getQueuedTurns(scope)]));
            try {
              const projection = await readCompleteNavigationQueue({
                owner,
                read: desktopApi.getNavigationQueueProjection!,
                previous: baselines.get(baselineKey),
                isCancelled: () => cancelled,
              });
              if (cancelled) return;
              baselines.set(baselineKey, projection);
              if (baselineKey === selectedKey) setSelectedState({ ownerKey: baselineKey, readiness: "ready", projection });
              for (const [scope, atReadStart] of captured) {
                const resolved = resolveComposerScopeOwner(composerDraftStore!, scope);
                if (resolved.state !== "known" || buildOwnedComposerScopeKey(resolved.owner) !== baselineKey) continue;
                const existing = composerDraftStore!.getQueuedTurns(scope);
                const next = reconcileCompleteNavigationQueue({ owner, projection, atReadStart, current: existing });
                if (JSON.stringify(next) !== JSON.stringify(existing)) composerDraftStore!.setQueuedTurns(scope, next);
              }
            } catch (error) {
              // A failed or partial read is never evidence that a FIFO is empty.
              if (!cancelled && baselineKey === selectedKey) setSelectedState({
                ownerKey: baselineKey, readiness: "failed", projection: baselines.get(baselineKey),
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }));
        const owners = new Set(demands.keys());
        for (const key of baselines.keys()) if (!owners.has(key)) baselines.delete(key);
      } finally {
        running = false;
        if (dirty && !cancelled) { dirty = false; schedule(); }
      }
    };
    const schedule = (): void => {
      if (timer !== undefined || cancelled) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    };
    refreshRef.current = refresh;
    const unsubscribeQueue = composerDraftStore?.subscribeQueuedTurns(schedule);
    const unsubscribeEvents = desktopApi.onAgentEvent?.((event) => {
      const method = event.notification.method;
      if (method.startsWith("turn/") || method.startsWith("thread/queued")
        || method === "thread/turnQueue/updated"
        || method.startsWith("thread/executionMode/") || method === "thread/status/changed") schedule();
    });
    void refresh();
    // Independent queue ownership survives hidden navigation demand.
    const interval = setInterval(schedule, 60_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(interval);
      refreshRef.current = async () => {};
      unsubscribeQueue?.();
      unsubscribeEvents?.();
    };
  }, [composerDraftStore, desktopApi, selectedKey]);
  return {
    ...(selectedState.ownerKey === selectedKey ? selectedState : { ownerKey: selectedKey, readiness: "loading" as const }),
    refresh: refreshSelected,
  };
}
