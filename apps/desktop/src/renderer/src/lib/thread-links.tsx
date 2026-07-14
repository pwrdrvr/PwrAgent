import {
  isThreadLinkId,
  parseThreadUrl,
  type AppServerBackendKind,
  type NavigationThreadSummary,
  type ThreadLinkRef,
} from "@pwragent/shared";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type ResolvedThreadLink = {
  backend: AppServerBackendKind;
  threadId: string;
  title: string;
  gitBranch?: string;
};

export type ThreadLinkContextValue = {
  /**
   * Returns the thread a link points at, or undefined when it names a thread
   * this profile does not have. Callers render unresolved links as plain text
   * rather than a chip that goes nowhere.
   */
  resolve: (ref: ThreadLinkRef) => ResolvedThreadLink | undefined;
  show: (link: ResolvedThreadLink) => void;
};

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

export function ThreadLinkProvider(props: {
  children: ReactNode;
  onShowThread: (request: { backend: AppServerBackendKind; threadId: string }) => void;
  threads: NavigationThreadSummary[];
}) {
  const { onShowThread, threads } = props;

  const value = useMemo<ThreadLinkContextValue>(() => {
    const byThreadId = new Map<string, ResolvedThreadLink>();
    const byIdentity = new Map<string, ResolvedThreadLink>();

    for (const thread of threads) {
      const link: ResolvedThreadLink = {
        backend: thread.source,
        threadId: thread.id,
        title: thread.title,
        gitBranch: thread.gitBranch,
      };
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
        onShowThread({ backend: link.backend, threadId: link.threadId });
      },
    };
  }, [onShowThread, threads]);

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
