import {
  buildThreadIdentityKey,
  isThreadLinkId,
  parseThreadUrl,
  type AppServerBackendKind,
  type AppServerThreadTitleSource,
  type FederationInstanceId,
  type LinkedDirectorySummary,
  type NavigationThreadSummary,
  type ThreadLinkRef,
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

export type ResolvedThreadLink = {
  backend: AppServerBackendKind;
  inThreadList?: boolean;
  instanceId?: FederationInstanceId;
  instanceLabel?: string;
  messageId?: string;
  threadId: string;
  title: string;
  titleSource?: AppServerThreadTitleSource;
  gitBranch?: string;
  linkedDirectories?: LinkedDirectorySummary[];
};

export type ThreadLinkSource = {
  backend: AppServerBackendKind;
  instanceId: FederationInstanceId;
};

export type ThreadLinkContextValue = {
  /**
   * Returns the thread a link points at, or undefined when it names a thread
   * this profile does not have. Callers render unresolved links as plain text
   * rather than a chip that goes nowhere.
   */
  resolve: (ref: ThreadLinkRef) => ResolvedThreadLink | undefined;
  openRemoteViewer: (link: ResolvedThreadLink) => void;
  show: (link: ResolvedThreadLink) => void;
  getSnapshot: (link: ResolvedThreadLink) => ResolvedThreadLink;
  subscribe: (link: ResolvedThreadLink, listener: () => void) => () => void;
  /**
   * Marks the thread a hovered or focused link points at, so the matching
   * sidebar card can light up while the pointer rests on the link. Pass
   * `undefined` when the pointer leaves. Rows read it through
   * `useThreadLinkHoverTarget`.
   */
  setHoverTarget: (link: ThreadLinkHoverTarget | undefined) => void;
  getHoverTargetKey: () => string | undefined;
  subscribeHoverTarget: (listener: () => void) => () => void;
};

export type ThreadLinkHoverTarget = Pick<ResolvedThreadLink, "backend" | "threadId">;

/**
 * The key a hovered link is matched against a sidebar card by. Same shape as
 * the row's own identity key (`buildThreadIdentityKey(source, id)`) and as
 * `composerSourceThreadKey`, so a link to a pinned remote thread lights up
 * that row too — the instance is deliberately not part of the match.
 */
export function threadLinkHoverKey(link: ThreadLinkHoverTarget): string {
  return buildThreadIdentityKey(link.backend, link.threadId);
}

/**
 * Hover state is a separate store from the metadata store: it changes on
 * every pointer enter/leave, and only the row it names (plus the one it just
 * left) should re-render — not the provider, and not the transcript.
 */
class ThreadLinkHoverStore {
  private key: string | undefined;
  private listeners = new Set<() => void>();

  get(): string | undefined {
    return this.key;
  }

  set(link: ThreadLinkHoverTarget | undefined): void {
    const nextKey = link ? threadLinkHoverKey(link) : undefined;
    if (nextKey === this.key) {
      return;
    }
    this.key = nextKey;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function threadLinkKey(
  link: Pick<ResolvedThreadLink, "backend" | "instanceId" | "threadId">,
): string {
  return `${link.instanceId ?? "local"}:${buildThreadIdentityKey(
    link.backend,
    link.threadId,
  )}`;
}

function threadSummaryLink(thread: NavigationThreadSummary): ResolvedThreadLink {
  const target = thread.federation?.ref.target;
  return {
    backend: thread.source,
    inThreadList: true,
    ...(target?.scope === "remote" ? { instanceId: target.instanceId } : {}),
    ...(thread.federation?.instanceLabel
      ? { instanceLabel: thread.federation.instanceLabel }
      : {}),
    threadId: thread.id,
    title: thread.title,
    titleSource: thread.titleSource,
    gitBranch: thread.gitBranch,
    linkedDirectories: thread.linkedDirectories,
  };
}

function sameThreadLink(
  left: ResolvedThreadLink | undefined,
  right: ResolvedThreadLink,
): boolean {
  return Boolean(
    left
    && left.title === right.title
    && left.titleSource === right.titleSource
    && left.instanceLabel === right.instanceLabel
    && left.gitBranch === right.gitBranch
    && linkedDirectoryMetadata(left.linkedDirectories)
      === linkedDirectoryMetadata(right.linkedDirectories)
  );
}

function linkedDirectoryMetadata(
  directories: LinkedDirectorySummary[] | undefined,
): string {
  return JSON.stringify(
    (directories ?? []).map((directory) => [
      directory.id,
      directory.label,
      directory.kind,
      directory.path,
      directory.worktreePath ?? null,
    ]),
  );
}

function threadLinkMetadataKey(threads: NavigationThreadSummary[]): string {
  return JSON.stringify(
    threads.map((thread) => [
      thread.source,
      thread.federation?.ref.target.scope === "remote"
        ? thread.federation.ref.target.instanceId
        : null,
      thread.id,
      thread.title,
      thread.titleSource,
      thread.federation?.instanceLabel ?? null,
      thread.gitBranch ?? null,
      linkedDirectoryMetadata(thread.linkedDirectories),
    ]),
  );
}

/**
 * A narrowly-scoped external store for mutable thread-link metadata.
 *
 * The surrounding context stays stable when only a title or branch changes,
 * so the open transcript does not re-render and re-parse all of its markdown.
 * Subscribers are partitioned by thread identity, which means a rename wakes
 * only chips that point at that thread.
 */
class ThreadLinkMetadataStore {
  private links = new Map<string, ResolvedThreadLink>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(threads: NavigationThreadSummary[]) {
    for (const thread of threads) {
      const link = threadSummaryLink(thread);
      this.links.set(threadLinkKey(link), link);
    }
  }

  getSnapshot(fallback: ResolvedThreadLink): ResolvedThreadLink {
    return this.links.get(threadLinkKey(fallback)) ?? fallback;
  }

  subscribe(link: ResolvedThreadLink, listener: () => void): () => void {
    const key = threadLinkKey(link);
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
    const nextLinks = new Map<string, ResolvedThreadLink>();
    const changedKeys = new Set<string>();

    for (const thread of threads) {
      const nextLink = threadSummaryLink(thread);
      const key = threadLinkKey(nextLink);
      const previousLink = this.links.get(key);
      const unchanged = sameThreadLink(previousLink, nextLink);
      nextLinks.set(key, unchanged && previousLink ? previousLink : nextLink);
      if (!unchanged) {
        changedKeys.add(key);
      }
    }

    for (const key of this.links.keys()) {
      if (!nextLinks.has(key)) {
        changedKeys.add(key);
      }
    }

    this.links = nextLinks;
    for (const key of changedKeys) {
      for (const listener of this.listeners.get(key) ?? []) {
        listener();
      }
    }
  }
}

/**
 * Absent by default. `ThreadMarkdown` also renders in the Activity, Changelog,
 * and markdown-file windows, which have no thread navigation — there, links
 * degrade to plain text instead of forcing every surface to thread an
 * `onShowThread` prop down five component layers.
 */
const ThreadLinkContext = createContext<ThreadLinkContextValue | undefined>(undefined);

export function useThreadLinks(): ThreadLinkContextValue | undefined {
  return useContext(ThreadLinkContext);
}

export function useLiveThreadLink(link: ResolvedThreadLink): ResolvedThreadLink {
  const links = useThreadLinks();
  const subscribe = useCallback(
    (listener: () => void) => links?.subscribe(link, listener) ?? (() => {}),
    [link, links],
  );
  const getSnapshot = useCallback(
    () => links?.getSnapshot(link) ?? link,
    [link, links],
  );

  const liveLink = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => link,
  );
  return useMemo(
    () => link.messageId
      ? { ...liveLink, messageId: link.messageId }
      : liveLink,
    [link.messageId, liveLink],
  );
}

/**
 * Whether a hovered or focused thread link currently points at `threadKey`
 * (a `buildThreadIdentityKey` value). Subscribes per row, so only the rows
 * whose answer flips re-render. Always false outside a `ThreadLinkProvider`.
 */
export function useThreadLinkHoverTarget(threadKey: string): boolean {
  const links = useThreadLinks();
  const subscribe = useCallback(
    (listener: () => void) =>
      links?.subscribeHoverTarget(listener) ?? (() => {}),
    [links],
  );
  const getSnapshot = useCallback(
    () => links?.getHoverTargetKey() === threadKey,
    [links, threadKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function ThreadLinkProvider(props: {
  children: ReactNode;
  onOpenRemoteViewer?: (request: {
    backend: AppServerBackendKind;
    instanceId: FederationInstanceId;
    instanceLabel?: string;
    messageId?: string;
    threadId: string;
  }) => void;
  onShowThread: (request: {
    backend: AppServerBackendKind;
    instanceId?: FederationInstanceId;
    instanceLabel?: string;
    inThreadList?: boolean;
    messageId?: string;
    threadId: string;
  }) => void;
  threads: NavigationThreadSummary[];
}) {
  const { onShowThread, threads } = props;
  const metadataStoreRef = useRef<ThreadLinkMetadataStore | null>(null);
  if (!metadataStoreRef.current) {
    metadataStoreRef.current = new ThreadLinkMetadataStore(threads);
  }
  const metadataStore = metadataStoreRef.current;
  const hoverStoreRef = useRef<ThreadLinkHoverStore | null>(null);
  if (!hoverStoreRef.current) {
    hoverStoreRef.current = new ThreadLinkHoverStore();
  }
  const hoverStore = hoverStoreRef.current;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const metadataKey = threadLinkMetadataKey(threads);

  useLayoutEffect(() => {
    metadataStore.update(threadsRef.current);
  }, [metadataKey, metadataStore]);

  // `threads` is `navigation.threads` — a fresh array on every snapshot patch
  // (unread flips, updatedAt bumps, title generation). This provider wraps the
  // whole app, so a value that changed identity on every patch would re-render
  // and re-parse every ThreadMarkdown in the open transcript. Instead we key
  // the value on a *membership* signature: it changes only when the set of
  // resolvable threads changes — i.e. when a link should flip between a chip
  // and plain text. Title/branch churn within a stable membership is not
  // reflected in the context value. The per-thread metadata store above
  // updates only chips that reference the changed thread.
  const membershipKey = useMemo(
    () => threads.map((thread) => threadLinkKey(threadSummaryLink(thread)))
      .sort()
      .join("\u0000"),
    [threads],
  );

  // Read the latest inputs through refs so the value can be rebuilt from
  // current data at each membership change without listing them as deps.
  const onShowThreadRef = useRef(onShowThread);
  onShowThreadRef.current = onShowThread;
  const onOpenRemoteViewerRef = useRef(props.onOpenRemoteViewer);
  onOpenRemoteViewerRef.current = props.onOpenRemoteViewer;

  const value = useMemo<ThreadLinkContextValue>(() => {
    const byThreadId = new Map<string, ResolvedThreadLink>();
    const byIdentity = new Map<string, ResolvedThreadLink>();
    const byFederatedIdentity = new Map<string, ResolvedThreadLink>();

    for (const thread of threadsRef.current) {
      const link = threadSummaryLink(thread);
      byIdentity.set(buildThreadIdentityKey(thread.source, thread.id), link);
      if (link.instanceId) {
        byFederatedIdentity.set(threadLinkKey(link), link);
      }
      // Thread ids are backend-generated and effectively unique, so a bare
      // `pwragent://thread/<id>` resolves without a backend hint. If two
      // backends ever collide on an id, the explicit `?backend=` form wins.
      if (!byThreadId.has(thread.id)) {
        byThreadId.set(thread.id, link);
      }
    }

    return {
      openRemoteViewer(link) {
        if (!link.instanceId) {
          return;
        }
        onOpenRemoteViewerRef.current?.({
          backend: link.backend,
          instanceId: link.instanceId,
          ...(link.instanceLabel ? { instanceLabel: link.instanceLabel } : {}),
          ...(link.messageId ? { messageId: link.messageId } : {}),
          threadId: link.threadId,
        });
      },
      resolve(ref) {
        let resolved: ResolvedThreadLink | undefined;
        if (ref.instanceId) {
          if (!ref.backend) {
            return undefined;
          }
          resolved = byFederatedIdentity.get(threadLinkKey({
            backend: ref.backend,
            instanceId: ref.instanceId,
            threadId: ref.threadId,
          }));
          if (!resolved) {
            // Remote links stay actionable without a navigation row, but the
            // synthetic fallback must not hydrate through metadata that may
            // still be awaiting removal from the store's layout effect.
            return {
              backend: ref.backend,
              instanceId: ref.instanceId,
              ...(ref.messageId ? { messageId: ref.messageId } : {}),
              threadId: ref.threadId,
              title: "",
            };
          }
        } else if (ref.backend) {
          resolved = byIdentity.get(
            buildThreadIdentityKey(ref.backend, ref.threadId),
          );
        } else {
          resolved = byThreadId.get(ref.threadId);
        }

        // The maps above are rebuilt only when membership changes, so their
        // metadata may predate a live rename. Resolve through the mutable store
        // before returning a value to one-shot consumers such as the composer.
        if (!resolved) {
          return undefined;
        }
        const liveResolved = metadataStore.getSnapshot(resolved);
        return ref.messageId
          ? { ...liveResolved, messageId: ref.messageId }
          : liveResolved;
      },
      show(link) {
        onShowThreadRef.current({
          backend: link.backend,
          ...(link.instanceId ? { instanceId: link.instanceId } : {}),
          ...(link.instanceLabel ? { instanceLabel: link.instanceLabel } : {}),
          ...(link.instanceId && link.inThreadList ? { inThreadList: true } : {}),
          ...(link.messageId ? { messageId: link.messageId } : {}),
          threadId: link.threadId,
        });
      },
      getSnapshot(link) {
        return metadataStore.getSnapshot(link);
      },
      subscribe(link, listener) {
        return metadataStore.subscribe(link, listener);
      },
      setHoverTarget(link) {
        hoverStore.set(link);
      },
      getHoverTargetKey() {
        return hoverStore.get();
      },
      subscribeHoverTarget(listener) {
        return hoverStore.subscribe(listener);
      },
    };
    // Rebuild only when membership changes; `threadsRef`/`onShowThreadRef`
    // carry the freshest values so no other deps are needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverStore, membershipKey, metadataStore]);

  return <ThreadLinkContext.Provider value={value}>{props.children}</ThreadLinkContext.Provider>;
}

/**
 * Resolve an href that may be a `pwragent://thread/…` link.
 */
export function resolveThreadHref(
  href: string,
  links: ThreadLinkContextValue | undefined,
  source?: ThreadLinkSource,
): ResolvedThreadLink | undefined {
  const ref = parseThreadUrl(href);
  if (!ref || !links) {
    return undefined;
  }

  return links.resolve(qualifyThreadLinkRef(ref, source));
}

/**
 * Resolve a bare thread id that an agent wrote as inline code rather than as a
 * link. Transcripts written before the link protocol existed — and any model
 * that ignores the convention — put the raw id in a code span; recognizing it
 * makes those threads reachable without asking anyone to re-run anything.
 *
 * Gated on the id resolving to a real thread, so an unrelated uuid in a code
 * span stays plain code.
 */
export function resolveThreadIdText(
  text: string,
  links: ThreadLinkContextValue | undefined,
): ResolvedThreadLink | undefined {
  if (!links) {
    return undefined;
  }

  const trimmed = text.trim();
  if (!isThreadLinkId(trimmed)) {
    return undefined;
  }

  return links.resolve({ threadId: trimmed });
}

function qualifyThreadLinkRef(
  ref: ThreadLinkRef,
  source: ThreadLinkSource | undefined,
): ThreadLinkRef {
  if (!source || ref.instanceId) {
    return ref;
  }

  return {
    ...ref,
    backend: ref.backend ?? source.backend,
    instanceId: source.instanceId,
  };
}
