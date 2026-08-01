import {
  isThreadLinkId,
  parseThreadUrl,
  type AppServerBackendKind,
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
  threadId: string;
  title: string;
  gitBranch?: string;
  linkedDirectories?: LinkedDirectorySummary[];
};

export type ThreadLinkContextValue = {
  /**
   * Returns the thread a link points at, or undefined when it names a thread
   * this profile does not have. Callers render unresolved links as plain text
   * rather than a chip that goes nowhere.
   */
  resolve: (ref: ThreadLinkRef) => ResolvedThreadLink | undefined;
  show: (link: ResolvedThreadLink) => void;
  getSnapshot: (link: ResolvedThreadLink) => ResolvedThreadLink;
  subscribe: (link: ResolvedThreadLink, listener: () => void) => () => void;
};

function threadLinkKey(link: Pick<ResolvedThreadLink, "backend" | "threadId">): string {
  return `${link.backend}:${link.threadId}`;
}

function threadSummaryLink(thread: NavigationThreadSummary): ResolvedThreadLink {
  return {
    backend: thread.source,
    threadId: thread.id,
    title: thread.title,
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
      thread.id,
      thread.title,
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

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => link,
  );
}

export function ThreadLinkProvider(props: {
  children: ReactNode;
  onShowThread: (request: { backend: AppServerBackendKind; threadId: string }) => void;
  threads: NavigationThreadSummary[];
}) {
  const { onShowThread, threads } = props;
  const metadataStoreRef = useRef<ThreadLinkMetadataStore | null>(null);
  if (!metadataStoreRef.current) {
    metadataStoreRef.current = new ThreadLinkMetadataStore(threads);
  }
  const metadataStore = metadataStoreRef.current;
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
    () => threads.map((thread) => `${thread.source}:${thread.id}`).sort().join("\u0000"),
    [threads],
  );

  // Read the latest inputs through refs so the value can be rebuilt from
  // current data at each membership change without listing them as deps.
  const onShowThreadRef = useRef(onShowThread);
  onShowThreadRef.current = onShowThread;

  const value = useMemo<ThreadLinkContextValue>(() => {
    const byThreadId = new Map<string, ResolvedThreadLink>();
    const byIdentity = new Map<string, ResolvedThreadLink>();

    for (const thread of threadsRef.current) {
      const link = threadSummaryLink(thread);
      byIdentity.set(`${thread.source}:${thread.id}`, link);
      // Thread ids are backend-generated and effectively unique, so a bare
      // `pwragent://thread/<id>` resolves without a backend hint. If two
      // backends ever collide on an id, the explicit `?backend=` form wins.
      if (!byThreadId.has(thread.id)) {
        byThreadId.set(thread.id, link);
      }
    }

    return {
      resolve(ref) {
        if (ref.backend) {
          return byIdentity.get(`${ref.backend}:${ref.threadId}`);
        }
        return byThreadId.get(ref.threadId);
      },
      show(link) {
        onShowThreadRef.current({ backend: link.backend, threadId: link.threadId });
      },
      getSnapshot(link) {
        return metadataStore.getSnapshot(link);
      },
      subscribe(link, listener) {
        return metadataStore.subscribe(link, listener);
      },
    };
    // Rebuild only when membership changes; `threadsRef`/`onShowThreadRef`
    // carry the freshest values so no other deps are needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey, metadataStore]);

  return <ThreadLinkContext.Provider value={value}>{props.children}</ThreadLinkContext.Provider>;
}

/**
 * Resolve an href that may be a `pwragent://thread/…` link.
 */
export function resolveThreadHref(
  href: string,
  links: ThreadLinkContextValue | undefined,
): ResolvedThreadLink | undefined {
  const ref = parseThreadUrl(href);
  if (!ref || !links) {
    return undefined;
  }

  return links.resolve(ref);
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
