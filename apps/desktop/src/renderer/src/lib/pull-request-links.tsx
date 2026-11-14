import {
  buildPullRequestStatusKey,
  pullRequestMatchesRepositoryKey,
  resolvePullRequestIdentity,
  threadTodoThreadKey,
  type AppServerBackendKind,
  type FederationRemoteTarget,
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
import { federationTargetsEqual, threadSummaryIdentityKey } from "./federated-thread-events";

export type PullRequestLinkContextValue = {
  hasPeerStatusAuthority: (pr: PrSummary) => boolean;
  getSnapshot: (fallback: PrSummary) => PrSummary;
  getNumberSnapshot: (number: number) => PrSummary | undefined;
  resolve: (href: string) => PrSummary | undefined;
  subscribe: (pr: PrSummary, listener: () => void) => () => void;
  subscribeNumber: (number: number, listener: () => void) => () => void;
  getThreadNumberSnapshot: (
    request: ThreadPullRequestNumberRequest,
  ) => PrSummary | undefined;
  subscribeThreadNumbers: (listener: () => void) => () => void;
};

/**
 * A bare PR number named by one thread, such as a to-do's merge card. The
 * number resolves against that owner's thread attachments, then against PRs
 * matching the repository identity its owner supplies for `projectPath`.
 * It resolves only when exactly one PR matches.
 */
export type ThreadPullRequestNumberRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  number: number;
  projectPath?: string;
  federationTarget?: FederationRemoteTarget;
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
    && left.sourceRepository?.provider === right.sourceRepository?.provider
    && left.sourceRepository?.org === right.sourceRepository?.org
    && left.sourceRepository?.repo === right.sourceRepository?.repo
    && left.number === right.number
    && left.title === right.title
    && left.additions === right.additions
    && left.deletions === right.deletions
    && left.changedFiles === right.changedFiles
    && left.commitCount === right.commitCount
    && left.createdAt === right.createdAt
    && left.mergedAt === right.mergedAt
    && left.closedAt === right.closedAt
    && left.state === right.state
    && left.checkState === right.checkState
    && left.checksStillRunning === right.checksStillRunning
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
  private numberListeners = new Map<number, Set<() => void>>();
  private prs = new Map<string, PrSummary>();
  private peerOwnedKeys = new Set<string>();
  private shorthandPrs = new Map<number, PrSummary>();
  private threads: NavigationThreadSummary[];
  private threadNumberListeners = new Set<() => void>();
  /** Resolutions for the current `threads`, keyed by request. */
  private threadNumberSnapshots = new Map<string, PrSummary | undefined>();

  constructor(
    threads: NavigationThreadSummary[],
    activeThread: NavigationThreadSummary | undefined,
  ) {
    this.threads = threads;
    const candidates = pullRequestsByKey(threads);
    this.prs = new Map([...candidates].map(([key, candidate]) => [key, candidate.pr]));
    this.peerOwnedKeys = new Set([...candidates].filter(([, candidate]) => candidate.peerOwned).map(([key]) => key));
    this.shorthandPrs = pullRequestsByNumberForActiveProject({
      activeThread,
      prsByKey: this.prs,
      threads,
    });
  }

  hasPeerStatusAuthority(pr: PrSummary): boolean {
    return this.peerOwnedKeys.has(buildPullRequestStatusKey(pr));
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

  getNumberSnapshot(number: number): PrSummary | undefined {
    return this.shorthandPrs.get(number);
  }

  subscribeNumber(number: number, listener: () => void): () => void {
    const listeners = this.numberListeners.get(number) ?? new Set();
    listeners.add(listener);
    this.numberListeners.set(number, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.numberListeners.delete(number);
      }
    };
  }

  /**
   * Returns the canonical object from `prs`, so repeated reads stay
   * referentially equal until that PR's row changes.
   */
  getThreadNumberSnapshot(
    request: ThreadPullRequestNumberRequest,
  ): PrSummary | undefined {
    // useSyncExternalStore reads on every render and every wake; scan the
    // thread list once per navigation update instead.
    const cacheKey = [threadTodoThreadKey(request), request.number, request.projectPath ?? ""]
      .join("\u0000");
    if (this.threadNumberSnapshots.has(cacheKey)) {
      return this.threadNumberSnapshots.get(cacheKey);
    }
    const resolved = this.resolveThreadNumber(request);
    this.threadNumberSnapshots.set(cacheKey, resolved);
    return resolved;
  }

  private resolveThreadNumber(
    request: ThreadPullRequestNumberRequest,
  ): PrSummary | undefined {
    const threadKey = threadTodoThreadKey(request);
    const thread = this.threads.find((candidate) => threadSummaryIdentityKey(candidate) === threadKey);
    const own = thread ? this.uniqueNumberMatch([thread], request.number) : undefined;
    if (own !== undefined) {
      return own ?? undefined;
    }
    const projectPath = normalizeProjectPath(request.projectPath);
    const repositoryKeys = thread ? threadRepositoryKeys(thread, projectPath) : new Set<string>();
    if (repositoryKeys.size === 0 && projectPath) {
      // Paths select directory metadata on the card's owner only. They never
      // authorize importing that directory's threads' attachment history.
      for (const candidate of this.threads) {
        if (!federationTargetsEqual(candidate.federation?.ref.target, request.federationTarget)) continue;
        for (const key of threadRepositoryKeys(candidate, projectPath)) repositoryKeys.add(key);
      }
    }
    return this.uniqueNumberMatch(this.threads, request.number, [...repositoryKeys]) ?? undefined;
  }

  /**
   * The one PR with this number among the threads' attachments. `undefined`
   * when none has it, `null` when more than one repository does.
   */
  private uniqueNumberMatch(
    threads: NavigationThreadSummary[],
    number: number,
    repositoryKeys?: readonly string[],
  ): PrSummary | null | undefined {
    let match: string | undefined;
    for (const thread of threads) {
      for (const pr of thread.prs ?? []) {
        if (pr.number !== number) continue;
        if (repositoryKeys && !repositoryKeys.some((key) => pullRequestMatchesRepositoryKey(pr, key))) continue;
        const key = buildPullRequestStatusKey(pr);
        if (match !== undefined && match !== key) return null;
        match = key;
      }
    }
    return match === undefined ? undefined : this.prs.get(match);
  }

  subscribeThreadNumbers(listener: () => void): () => void {
    this.threadNumberListeners.add(listener);
    return () => {
      this.threadNumberListeners.delete(listener);
    };
  }

  update(
    threads: NavigationThreadSummary[],
    activeThread: NavigationThreadSummary | undefined,
  ): void {
    const candidates = pullRequestsByKey(threads);
    const nextPrs = new Map<string, PrSummary>();
    const nextPeerOwnedKeys = new Set<string>();
    const changedKeys = new Set<string>();

    for (const [key, { pr: candidate, peerOwned }] of candidates) {
      const previous = this.prs.get(key);
      if (peerOwned) nextPeerOwnedKeys.add(key);
      // An ownership-only transition must wake useSyncExternalStore too, even
      // when both observations happen to have identical visible metadata.
      const unchanged = samePullRequestChip(previous, candidate)
        && this.peerOwnedKeys.has(key) === peerOwned;
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

    const nextShorthandPrs = pullRequestsByNumberForActiveProject({
      activeThread,
      prsByKey: nextPrs,
      threads,
    });
    const changedNumbers = new Set<number>();
    for (const [number, candidate] of nextShorthandPrs) {
      if (!samePullRequestChip(this.shorthandPrs.get(number), candidate)) {
        changedNumbers.add(number);
      }
    }
    for (const number of this.shorthandPrs.keys()) {
      if (!nextShorthandPrs.has(number)) {
        changedNumbers.add(number);
      }
    }

    const threadsChanged = threads !== this.threads;
    this.prs = nextPrs;
    this.peerOwnedKeys = nextPeerOwnedKeys;
    this.shorthandPrs = nextShorthandPrs;
    this.threads = threads;
    if (threadsChanged) {
      this.threadNumberSnapshots.clear();
    }
    for (const key of changedKeys) {
      for (const listener of this.listeners.get(key) ?? []) {
        listener();
      }
    }
    for (const number of changedNumbers) {
      for (const listener of this.numberListeners.get(number) ?? []) {
        listener();
      }
    }
    // Few cards subscribe, and each re-read returns the same object unless
    // its PR changed, so a broad wake costs no render.
    if (threadsChanged) {
      for (const listener of this.threadNumberListeners) {
        listener();
      }
    }
  }
}

type PullRequestCandidate = { pr: PrSummary; peerOwned: boolean; priority: number };

function pullRequestsByKey(
  threads: NavigationThreadSummary[],
): Map<string, PullRequestCandidate> {
  const prs = new Map<string, PullRequestCandidate>();
  for (const thread of threads) {
    const peerOwned = thread.federation?.ref.target.scope === "remote";
    for (const rawPr of thread.prs ?? []) {
      const pr = { ...rawPr, ...resolvePullRequestIdentity(rawPr) };
      const key = buildPullRequestStatusKey(pr);
      // Main resolves this field with the same primary-workspace probe used by
      // collectPrPollTargets. A local secondary attachment cannot claim status
      // authority merely because it appears before a pinned peer in the list.
      const localPrimary = !peerOwned && pullRequestMatchesRepositoryKey(pr, thread.primaryGitRepository);
      const priority = localPrimary ? 2 : peerOwned ? 1 : 0;
      if (!prs.has(key) || priority > prs.get(key)!.priority) {
        prs.set(key, { pr, peerOwned, priority });
      }
    }
  }
  return prs;
}

function pullRequestsByNumberForActiveProject(params: {
  activeThread: NavigationThreadSummary | undefined;
  prsByKey: Map<string, PrSummary>;
  threads: NavigationThreadSummary[];
}): Map<number, PrSummary> {
  if (!params.activeThread) {
    return new Map();
  }

  const selectedThread = params.activeThread;
  const activeThread = params.threads.find(
    (thread) => threadSummaryIdentityKey(thread) === threadSummaryIdentityKey(selectedThread),
  ) ?? selectedThread;
  const activeKey = threadSummaryIdentityKey(activeThread);
  const repositoryKeys = threadRepositoryKeys(activeThread);
  const candidatesByNumber = new Map<number, Map<string, PrSummary>>();

  // Selected detail can be present before its navigation row is loaded.
  const candidates = [activeThread, ...params.threads.filter(
    (thread) => threadSummaryIdentityKey(thread) !== activeKey,
  )];
  for (const thread of candidates) {
    const sameThread = threadSummaryIdentityKey(thread) === activeKey;
    for (const pr of thread.prs ?? []) {
      // An attachment can outlive the directory it came from. Only the active
      // thread's own attachments establish scope without a repository match.
      if (!sameThread && ![...repositoryKeys].some((key) => pullRequestMatchesRepositoryKey(pr, key))) {
        continue;
      }
      const key = buildPullRequestStatusKey(pr);
      const byKey = candidatesByNumber.get(pr.number) ?? new Map();
      byKey.set(key, params.prsByKey.get(key) ?? pr);
      candidatesByNumber.set(pr.number, byKey);
    }
  }

  const resolved = new Map<number, PrSummary>();
  for (const [number, candidates] of candidatesByNumber) {
    if (candidates.size === 1) {
      const [pr] = candidates.values();
      if (pr) {
        resolved.set(number, pr);
      }
    }
  }
  return resolved;
}

function threadRepositoryKeys(thread: NavigationThreadSummary, projectPath?: string): Set<string> {
  const keys = new Set<string>();
  const add = (key: string | undefined) => {
    if (key?.trim()) keys.add(key.trim().toLowerCase());
  };
  const matchesProject = (directory: NavigationThreadSummary["linkedDirectories"][number]) =>
    !projectPath
    || normalizeProjectPath(directory.path) === projectPath
    || normalizeProjectPath(directory.worktreePath) === projectPath;
  const primary = thread.linkedDirectories?.[0];
  if (!projectPath || normalizeProjectPath(thread.projectKey) === projectPath || (primary && matchesProject(primary))) {
    add(thread.primaryGitRepository);
  }
  for (const directory of thread.linkedDirectories ?? []) {
    if (!matchesProject(directory)) continue;
    add(directory.repositoryKey);
    for (const key of directory.repositoryKeys ?? []) add(key);
  }
  return keys;
}

function normalizeProjectPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

const PullRequestLinkContext =
  createContext<PullRequestLinkContextValue | undefined>(undefined);

export function PullRequestLinkProvider(props: {
  activeThread?: NavigationThreadSummary;
  children: ReactNode;
  threads: NavigationThreadSummary[];
}) {
  const storeRef = useRef<PullRequestLinkMetadataStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new PullRequestLinkMetadataStore(
      props.threads,
      props.activeThread,
    );
  }
  const store = storeRef.current;

  useLayoutEffect(() => {
    store.update(props.threads, props.activeThread);
  }, [props.activeThread, props.threads, store]);

  const value = useMemo<PullRequestLinkContextValue>(
    () => ({
      hasPeerStatusAuthority(pr) {
        return store.hasPeerStatusAuthority(pr);
      },
      getSnapshot(fallback) {
        return store.getSnapshot(fallback);
      },
      getNumberSnapshot(number) {
        return store.getNumberSnapshot(number);
      },
      resolve(href) {
        // Keep the parsed unknown summary as the chip's durable fallback. The
        // live hook hydrates it synchronously from the store, and can return to
        // it if the last matching navigation PR is later detached.
        return parsePullRequestUrl(href);
      },
      subscribe(pr, listener) {
        return store.subscribe(pr, listener);
      },
      subscribeNumber(number, listener) {
        return store.subscribeNumber(number, listener);
      },
      getThreadNumberSnapshot(request) {
        return store.getThreadNumberSnapshot(request);
      },
      subscribeThreadNumbers(listener) {
        return store.subscribeThreadNumbers(listener);
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

export function useLivePullRequestNumber(number: number): PrSummary | undefined {
  const links = usePullRequestLinks();
  const subscribe = useCallback(
    (listener: () => void) =>
      links?.subscribeNumber(number, listener) ?? (() => {}),
    [links, number],
  );
  const getSnapshot = useCallback(
    () => links?.getNumberSnapshot(number),
    [links, number],
  );

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => undefined,
  );
}

export function useThreadPullRequestNumber(
  request: ThreadPullRequestNumberRequest | undefined,
): PrSummary | undefined {
  const links = usePullRequestLinks();
  const backend = request?.backend;
  const threadId = request?.threadId;
  const number = request?.number;
  const projectPath = request?.projectPath;
  const instanceId = request?.federationTarget?.instanceId;
  const subscribe = useCallback(
    (listener: () => void) =>
      links?.subscribeThreadNumbers(listener) ?? (() => {}),
    [links],
  );
  const getSnapshot = useCallback(
    () => backend !== undefined && threadId !== undefined && number !== undefined
      ? links?.getThreadNumberSnapshot({
          backend,
          threadId,
          number,
          ...(projectPath ? { projectPath } : {}),
          ...(instanceId ? { federationTarget: { scope: "remote", instanceId } as const } : {}),
        })
      : undefined,
    [links, backend, threadId, number, projectPath, instanceId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

/**
 * The live status for a parsed PR, for callers outside a component that already
 * hold the context value (draft hydration). `useLivePullRequest` is the hook
 * form and stays the right choice inside a chip.
 */
export function resolveLivePullRequest(
  pr: PrSummary,
  links: PullRequestLinkContextValue | undefined,
): PrSummary {
  return links?.getSnapshot(pr) ?? pr;
}

export function resolvePullRequestHref(
  href: string,
  links: PullRequestLinkContextValue | undefined,
): PrSummary | undefined {
  return links?.resolve(href);
}

export function parseGitHubPullRequestUrl(href: string): PrSummary | undefined {
  const pullRequest = parsePullRequestUrl(href);
  if (
    pullRequest?.provider !== "github.com"
    || !pullRequestPathMarker(href, "pull")
  ) {
    return undefined;
  }
  return pullRequest;
}

export function parsePullRequestUrl(href: string): PrSummary | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:") {
    return undefined;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const markerIndex = segments.findIndex(
    (segment) => segment === "pull" || segment === "merge_requests",
  );
  if (markerIndex <= 0 || markerIndex >= segments.length - 1) {
    return undefined;
  }
  const numberText = segments[markerIndex + 1] ?? "";
  if (!/^[1-9]\d*$/.test(numberText)) {
    return undefined;
  }

  const repoIndex = segments[markerIndex - 1] === "-"
    ? markerIndex - 2
    : markerIndex - 1;
  if (repoIndex <= 0) {
    return undefined;
  }
  const orgSegments = segments
    .slice(0, repoIndex)
    .map(decodeUrlSegment);
  const org = orgSegments.every((segment): segment is string => Boolean(segment))
    ? orgSegments.join("/")
    : undefined;
  const repo = decodeUrlSegment(segments[repoIndex] ?? "");
  if (!org || !repo) {
    return undefined;
  }

  return {
    provider: parsed.hostname.toLowerCase(),
    org,
    repo,
    number: Number.parseInt(numberText, 10),
    state: "unknown",
    url: href,
  };
}

function pullRequestPathMarker(
  href: string,
  marker: "pull" | "merge_requests",
): boolean {
  try {
    return new URL(href).pathname.split("/").includes(marker);
  } catch {
    return false;
  }
}

function decodeUrlSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
