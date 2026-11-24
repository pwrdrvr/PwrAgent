import { useMemo, type ReactElement } from "react";
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
  const { backend, threadId, title, instanceLabel } = thread;
  const link = useMemo((): ResolvedThreadLink => {
    // Without thread links there is no remote viewer to open, so the link
    // names no owner and the chip offers no pop-out; `onOpen` still sends the
    // full reference, owner included, to main.
    if (!threadLinks) return { backend, threadId, title };
    const ref = { backend, threadId, ...(remote ? { instanceId: remote } : {}) };
    const resolved = threadLinks.resolve(ref) ?? { ...ref, title: "" };
    // A peer's thread that navigation has not loaded names its owner, not the owner's id.
    return remote && !resolved.instanceLabel && instanceLabel ? { ...resolved, instanceLabel } : resolved;
  }, [threadLinks, backend, threadId, title, remote, instanceLabel]);
  if (!onOpen && !threadLinks) {
    return <span>{title || threadId}</span>;
  }
  return (
    <ThreadChip
      fallbackLabel={title}
      link={link}
      onOpen={(opened) => {
        onNavigate?.();
        if (onOpen) onOpen(thread);
        else threadLinks?.show(opened);
      }}
    />
  );
}
