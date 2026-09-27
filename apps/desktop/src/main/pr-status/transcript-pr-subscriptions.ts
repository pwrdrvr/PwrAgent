import {
  buildPullRequestStatusKey,
  FORGE_PRODUCTS,
  type PrSummary,
  type SetTranscriptPullRequestsRequest,
  type TranscriptPullRequestStatuses,
} from "@pwragent/shared";
import { parseForgePrRefFromUrl } from "./forge-pr-ref";
import type { PrPollTarget } from "./pr-polling-scheduler";
import { getMainLogger } from "../log";

// Displaying authored text is not authorization to send CLI credentials to
// that text's host. Self-hosted references remain displayable via navigation
// snapshots and explicit attachments, but are not automatic transcript targets.
const AUTOMATIC_FORGE_ORIGINS = new Set([
  `https://${FORGE_PRODUCTS.github.saasHost}`,
  `https://${FORGE_PRODUCTS.gitlab.saasHost}`,
]);

const CACHE_GRACE_MS = 120_000;
const REFRESH_RETRY_MS = 15_000;

type CachedPr = {
  pr: PrSummary;
  fetchedAt: number;
  subscribers: Map<number, boolean>;
  visibleCount: number;
  eviction?: ReturnType<typeof setTimeout>;
};

/** Main-process, memory-only cache. Windows own interest, never PR attachments. */
export class TranscriptPrSubscriptions {
  private readonly senders = new Map<number, {
    keys: Set<string>;
    publish: (statuses: TranscriptPullRequestStatuses) => void;
  }>();
  private readonly cache = new Map<string, CachedPr>();
  private readonly active = new Map<string, CachedPr>();
  private readonly pendingKeys = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refresh: (() => Promise<void>) | undefined;

  constructor(private readonly onInactive?: (prKey: string) => void) {}

  get hasSubscribers(): boolean {
    return this.active.size > 0;
  }

  /** Apply only changed identities; scrolling never rebuilds all subscriptions. */
  set(
    sender: number,
    request: SetTranscriptPullRequestsRequest,
    publish: (statuses: TranscriptPullRequestStatuses) => void,
  ): TranscriptPullRequestStatuses {
    const owner = this.senders.get(sender) ?? { keys: new Set<string>(), publish };
    owner.publish = publish;
    this.senders.set(sender, owner);
    const statuses: TranscriptPullRequestStatuses["statuses"] = [];
    for (const url of request.removedUrls) {
      const pr = parseTranscriptPullRequest(url);
      if (pr) this.release(sender, buildPullRequestStatusKey(pr));
    }
    for (const subscription of request.updates) {
      const pr = parseTranscriptPullRequest(subscription.url);
      if (!pr) continue;
      const key = buildPullRequestStatusKey(pr);
      let cached = this.cache.get(key);
      if (!cached) {
        cached = { pr, fetchedAt: 0, subscribers: new Map(), visibleCount: 0 };
        this.cache.set(key, cached);
      }
      clearTimeout(cached.eviction);
      cached.eviction = undefined;
      const previouslyVisible = cached.subscribers.get(sender) ?? false;
      cached.visibleCount += Number(subscription.visible) - Number(previouslyVisible);
      cached.subscribers.set(sender, subscription.visible);
      owner.keys.add(key);
      this.active.set(key, cached);
      this.pendingKeys.add(key);
      if (cached.fetchedAt) statuses.push({ pr: cached.pr, fetchedAt: cached.fetchedAt });
    }
    if (!owner.keys.size) this.senders.delete(sender);
    return { statuses };
  }

  clearSender(sender: number): void {
    const owner = this.senders.get(sender);
    if (!owner) return;
    for (const key of owner.keys) this.release(sender, key);
    this.senders.delete(sender);
  }

  /** The scheduler's normal linear pass over distinct active PRs, never DOM nodes. */
  targets(): PrPollTarget[] {
    return [...this.active].map(([prKey, cached]) => this.target(prKey, cached));
  }

  pendingTargets(): PrPollTarget[] {
    const targets: PrPollTarget[] = [];
    for (const key of this.pendingKeys) {
      const cached = this.active.get(key);
      if (cached) targets.push(this.target(key, cached));
    }
    return targets;
  }

  markHandled(prKeys: string[]): void {
    for (const key of prKeys) this.pendingKeys.delete(key);
    if (!this.pendingKeys.size) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  requestRefresh(refresh: () => Promise<void>): void {
    this.refresh = refresh;
    this.scheduleRefresh(50);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer || this.refreshing || !this.pendingKeys.size) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshing = true;
      void this.runRefresh();
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  private async runRefresh(): Promise<void> {
    try {
      await this.refresh?.();
    } catch (error) {
      getMainLogger("pwragent:pr-poller").warn("failed to refresh transcript PR statuses", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.refreshing = false;
      // Drain admission backlog even without the background polling timer.
      // Only pending identities are revisited; admitted work never recurs here.
      this.scheduleRefresh(REFRESH_RETRY_MS);
    }
  }

  private target(prKey: string, cached: CachedPr): PrPollTarget {
    return {
      prKey,
      pr: cached.pr,
      fetchedAt: cached.fetchedAt,
      threadKeys: [],
      subscriptionTier: cached.visibleCount > 0 ? "focused" : "cold",
    };
  }

  observe(prs: PrSummary[], fetchedAt: number): void {
    const updates = new Map<number, TranscriptPullRequestStatuses>();
    for (const pr of prs) {
      const key = buildPullRequestStatusKey(pr);
      const cached = this.cache.get(key);
      if (!cached || fetchedAt <= cached.fetchedAt) continue;
      cached.pr = pr;
      cached.fetchedAt = fetchedAt;
      // Inverted ownership index: touch only windows subscribed to this PR.
      for (const sender of cached.subscribers.keys()) {
        let pending = updates.get(sender);
        if (!pending) {
          pending = { statuses: [] };
          updates.set(sender, pending);
        }
        pending.statuses.push({ pr, fetchedAt });
      }
    }
    for (const [sender, statuses] of updates) this.senders.get(sender)?.publish(statuses);
  }

  clear(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refresh = undefined;
    for (const cached of this.cache.values()) clearTimeout(cached.eviction);
    this.cache.clear();
    this.active.clear();
    this.pendingKeys.clear();
    this.senders.clear();
  }

  private release(sender: number, key: string): void {
    this.senders.get(sender)?.keys.delete(key);
    const cached = this.cache.get(key);
    if (!cached?.subscribers.has(sender)) return;
    if (cached.subscribers.get(sender)) cached.visibleCount -= 1;
    cached.subscribers.delete(sender);
    if (cached.subscribers.size) return;
    this.active.delete(key);
    this.markHandled([key]);
    this.onInactive?.(key);
    cached.eviction = setTimeout(() => this.cache.delete(key), CACHE_GRACE_MS);
    cached.eviction.unref?.();
  }
}

/** Strip authored deep links for fetching; the renderer retains the original URL. */
export function parseTranscriptPullRequest(value: string): PrSummary | undefined {
  try {
    const url = new URL(value);
    if (!AUTOMATIC_FORGE_ORIGINS.has(url.origin) || url.username || url.password) return undefined;
    const match = url.pathname.match(/^(.*\/(?:pull|merge_requests)\/[1-9]\d*)(?:\/.*)?$/);
    if (!match) return undefined;
    url.pathname = match[1]!;
    url.search = "";
    url.hash = "";
    const ref = parseForgePrRefFromUrl(url.href);
    return ref ? {
      provider: ref.host,
      org: ref.owner,
      repo: ref.repo,
      number: ref.number,
      url: url.href,
      state: "unknown",
    } : undefined;
  } catch {
    return undefined;
  }
}
