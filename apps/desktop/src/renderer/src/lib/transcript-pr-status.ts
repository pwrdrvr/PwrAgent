import {
  buildPullRequestStatusKey,
  type PrSummary,
  type TranscriptPullRequestStatuses,
} from "@pwragent/shared";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { type DesktopApi, useDesktopApi } from "./desktop-api";

/** One publisher per renderer, shared by every transcript and Star Map card. */
export class TranscriptPrStatusStore {
  private readonly entries = new Map<string, {
    url: string;
    subscribers: Map<() => void, boolean>;
    visibleCount: number;
    pr?: PrSummary;
    fetchedAt: number;
  }>();
  private readonly dirtyKeys = new Set<string>();
  private subscriberCount = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly api: DesktopApi) {}

  getSnapshot(key: string): PrSummary | undefined {
    return this.entries.get(key)?.pr;
  }

  subscribe(pr: PrSummary, visible: boolean, listener: () => void): () => void {
    const key = buildPullRequestStatusKey(pr);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { url: pr.url, subscribers: new Map(), visibleCount: 0, fetchedAt: 0 };
      this.entries.set(key, entry);
    }
    const wasVisible = entry.visibleCount > 0;
    const wasEmpty = entry.subscribers.size === 0;
    entry.subscribers.set(listener, visible);
    if (visible) entry.visibleCount += 1;
    this.subscriberCount += 1;
    this.unsubscribe ??= this.api.onTranscriptPullRequestStatuses?.((statuses) => this.receive(statuses));
    if (wasEmpty || wasVisible !== (entry.visibleCount > 0)) this.schedulePublish(key);
    return () => {
      const previouslyVisible = entry.visibleCount > 0;
      if (entry.subscribers.get(listener)) entry.visibleCount -= 1;
      entry.subscribers.delete(listener);
      this.subscriberCount -= 1;
      if (!entry.subscribers.size || previouslyVisible !== (entry.visibleCount > 0)) this.schedulePublish(key);
    };
  }

  private receive({ statuses }: TranscriptPullRequestStatuses): void {
    for (const { pr, fetchedAt } of statuses) {
      const entry = this.entries.get(buildPullRequestStatusKey(pr));
      if (!entry || entry.fetchedAt >= fetchedAt) continue;
      entry.pr = pr;
      entry.fetchedAt = fetchedAt;
      for (const listener of entry.subscribers.keys()) listener();
    }
  }

  private schedulePublish(key: string): void {
    this.dirtyKeys.add(key);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const updates: { url: string; visible: boolean }[] = [];
      const removedUrls: string[] = [];
      // Visibility changes touch only their PR identities, even in a transcript
      // with thousands of mounted chips. Counts avoid rescanning duplicates.
      for (const dirtyKey of this.dirtyKeys) {
        const entry = this.entries.get(dirtyKey);
        if (!entry) continue;
        if (!entry.subscribers.size) {
          removedUrls.push(entry.url);
          this.entries.delete(dirtyKey);
        } else {
          updates.push({ url: entry.url, visible: entry.visibleCount > 0 });
        }
      }
      this.dirtyKeys.clear();
      void this.api.setTranscriptPullRequests?.({ updates, removedUrls })
        .then((statuses) => this.receive(statuses))
        .catch(() => {
          // Provider failures retain the previous snapshot; main owns retries.
        });
      if (!this.subscriberCount) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    }, 50);
  }
}

const stores = new WeakMap<DesktopApi, TranscriptPrStatusStore>();

export function useTranscriptPullRequest(
  fallback: PrSummary,
  interest: { seen: boolean; visible: boolean },
): PrSummary {
  const api = useDesktopApi();
  const store = useMemo(() => {
    if (!api?.setTranscriptPullRequests || !api.onTranscriptPullRequestStatuses) return undefined;
    let existing = stores.get(api);
    if (!existing) {
      existing = new TranscriptPrStatusStore(api);
      stores.set(api, existing);
    }
    return existing;
  }, [api]);
  const key = buildPullRequestStatusKey(fallback);
  const subscribe = useCallback((listener: () => void) => {
    if (!interest.seen || !store) return () => {};
    return store.subscribe(fallback, interest.visible, listener);
  }, [fallback, interest.seen, interest.visible, store]);
  const getSnapshot = useCallback(() => store?.getSnapshot(key), [key, store]);
  const live = useSyncExternalStore(subscribe, getSnapshot, () => undefined);
  return useMemo(() => live ? { ...live, url: fallback.url } : fallback, [live, fallback]);
}
