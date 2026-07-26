import {
  buildPullRequestStatusKey,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

type PullRequestLinkContextValue = {
  getSnapshot: (fallback: PrSummary) => PrSummary;
  resolve: (href: string) => PrSummary | undefined;
  subscribe: (pr: PrSummary, listener: () => void) => () => void;
};

function samePullRequestChip(
  left: PrSummary | undefined,
  right: PrSummary,
): boolean {
  return Boolean(
    left
    && left.provider === right.provider
    && left.org === right.org
    && left.repo === right.repo
    && left.number === right.number
    && left.title === right.title
    && left.state === right.state
    && left.checkState === right.checkState
    && left.lifecycleState === right.lifecycleState
    && left.reviewState === right.reviewState
    && left.mergeState === right.mergeState
    && left.url === right.url,
  );
}

/**
 * Live PR metadata keyed by the same provider/repo/number identity used by the
 * pullRequest/status/updated navigation patcher. Only chips for a changed PR
 * are notified; ThreadMarkdown stays behind a stable context value.
 */
class PullRequestLinkMetadataStore {
  private hydratedSnapshots = new WeakMap<PrSummary, Map<string, PrSummary>>();
  private listeners = new Map<string, Set<() => void>>();
  private prs = new Map<string, PrSummary>();

  constructor(threads: NavigationThreadSummary[]) {
    this.prs = pullRequestsByKey(threads);
  }

  getSnapshot(fallback: PrSummary): PrSummary {
    const live = this.prs.get(buildPullRequestStatusKey(fallback));
    if (!live) {
      return fallback;
    }
    if (live.url === fallback.url) {
      return live;
    }

    // Status/title metadata belongs to the PR identity, but the URL belongs to
    // this authored transcript link. Preserve deep links such as /files or a
    // discussion fragment instead of replacing them with the cached root URL.
    const snapshotsByUrl = this.hydratedSnapshots.get(live) ?? new Map();
    const cached = snapshotsByUrl.get(fallback.url);
    if (cached) {
      return cached;
    }
    const hydrated = {
      ...live,
      url: fallback.url,
    };
    snapshotsByUrl.set(fallback.url, hydrated);
    this.hydratedSnapshots.set(live, snapshotsByUrl);
    return hydrated;
  }

  subscribe(pr: PrSummary, listener: () => void): () => void {
    const key = buildPullRequestStatusKey(pr);
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  update(threads: NavigationThreadSummary[]): void {
    const candidates = pullRequestsByKey(threads);
    const nextPrs = new Map<string, PrSummary>();
    const changedKeys = new Set<string>();

    for (const [key, candidate] of candidates) {
      const previous = this.prs.get(key);
      const unchanged = samePullRequestChip(previous, candidate);
      nextPrs.set(key, unchanged && previous ? previous : candidate);
      if (!unchanged) {
        changedKeys.add(key);
      }
    }

    for (const key of this.prs.keys()) {
      if (!nextPrs.has(key)) {
        changedKeys.add(key);
      }
    }

    this.prs = nextPrs;
    for (const key of changedKeys) {
      for (const listener of this.listeners.get(key) ?? []) {
        listener();
      }
    }
  }
}

function pullRequestsByKey(
  threads: NavigationThreadSummary[],
): Map<string, PrSummary> {
  const prs = new Map<string, PrSummary>();
  for (const thread of threads) {
    for (const pr of thread.prs ?? []) {
      const key = buildPullRequestStatusKey(pr);
      if (!prs.has(key)) {
        prs.set(key, pr);
      }
    }
  }
  return prs;
}

const PullRequestLinkContext =
  createContext<PullRequestLinkContextValue | undefined>(undefined);

export function PullRequestLinkProvider(props: {
  children: ReactNode;
  threads: NavigationThreadSummary[];
}) {
  const storeRef = useRef<PullRequestLinkMetadataStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new PullRequestLinkMetadataStore(props.threads);
  }
  const store = storeRef.current;

  useLayoutEffect(() => {
    store.update(props.threads);
  }, [props.threads, store]);

  const value = useMemo<PullRequestLinkContextValue>(
    () => ({
      getSnapshot(fallback) {
        return store.getSnapshot(fallback);
      },
      resolve(href) {
        // Keep the parsed unknown summary as the chip's durable fallback. The
        // live hook hydrates it synchronously from the store, and can return to
        // it if the last matching navigation PR is later detached.
        return parseGitHubPullRequestUrl(href);
      },
      subscribe(pr, listener) {
        return store.subscribe(pr, listener);
      },
    }),
    [store],
  );

  return (
    <PullRequestLinkContext.Provider value={value}>
      {props.children}
    </PullRequestLinkContext.Provider>
  );
}

export function usePullRequestLinks(): PullRequestLinkContextValue | undefined {
  return useContext(PullRequestLinkContext);
}

export function useLivePullRequest(pr: PrSummary): PrSummary {
  const links = usePullRequestLinks();
  const subscribe = useCallback(
    (listener: () => void) => links?.subscribe(pr, listener) ?? (() => {}),
    [links, pr],
  );
  const getSnapshot = useCallback(
    () => links?.getSnapshot(pr) ?? pr,
    [links, pr],
  );

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => pr,
  );
}

export function resolvePullRequestHref(
  href: string,
  links: PullRequestLinkContextValue | undefined,
): PrSummary | undefined {
  return links?.resolve(href);
}

export function parseGitHubPullRequestUrl(href: string): PrSummary | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "pull") {
    return undefined;
  }
  const numberText = segments[3] ?? "";
  if (!/^[1-9]\d*$/.test(numberText)) {
    return undefined;
  }

  const org = decodeUrlSegment(segments[0] ?? "");
  const repo = decodeUrlSegment(segments[1] ?? "");
  if (!org || !repo) {
    return undefined;
  }

  return {
    provider: "github.com",
    org,
    repo,
    number: Number.parseInt(numberText, 10),
    state: "unknown",
    url: href,
  };
}

function decodeUrlSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
