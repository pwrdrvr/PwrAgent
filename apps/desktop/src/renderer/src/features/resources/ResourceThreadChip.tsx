import type { ReactElement } from "react";
import type { ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";
import { useThreadLinks, type ResolvedThreadLink } from "../../lib/thread-links";
import { ThreadChip } from "../thread-detail/ThreadChip";

/**
 * A checkout holder or requester as the thread chip used everywhere else.
 *
 * Inside the main window the chip resolves through the thread links, so it
 * shows the live title and opens the thread there; `onNavigate` runs first so
 * a dialog showing the queue closes instead of covering the thread it opened.
 * The Resources window has no thread list, so it passes `onOpen` to ask main
 * to show the thread in the primary window. With neither, the title is text.
 *
 * Holders name their owning instance. `localInstanceId` is the snapshot
 * viewer's, so this instance's own threads read as local links rather than a
 * peer's, which would offer the remote viewer.
 */
export function ResourceThreadChip(props: {
  thread: ResourceThreadRef;
  localInstanceId?: string;
  onOpen?: (thread: ResourceThreadRef) => void;
  onNavigate?: () => void;
}): ReactElement {
  const { thread, onOpen, onNavigate } = props;
  const threadLinks = useThreadLinks();
  const remote = thread.instanceId && thread.instanceId !== props.localInstanceId ? thread.instanceId : undefined;
  const ref = { backend: thread.backend, threadId: thread.threadId, ...(remote ? { instanceId: remote } : {}) };
  const link: ResolvedThreadLink = threadLinks?.resolve(ref) ?? {
    ...ref,
    title: thread.title,
    ...(remote && thread.instanceLabel ? { instanceLabel: thread.instanceLabel } : {}),
  };
  if (!onOpen && !threadLinks) {
    return <span>{thread.title || thread.threadId}</span>;
  }
  return (
    <ThreadChip
      fallbackLabel={thread.title}
      link={link}
      onOpen={(opened) => {
        onNavigate?.();
        if (onOpen) onOpen(thread);
        else threadLinks?.show(opened);
      }}
    />
  );
}
