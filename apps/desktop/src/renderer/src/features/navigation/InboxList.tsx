import type { NavigationThreadSummary } from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import { ThreadRow } from "./ThreadRow";

type InboxListProps = {
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onOpenThreadContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ) => void;
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function InboxList(props: InboxListProps) {
  if (props.threads.length === 0) {
    return (
      <p className="sidebar-empty">
        No unread threads.
      </p>
    );
  }

  return (
    <div className="sidebar-list sidebar-list--dense" role="list">
      {props.threads.map((thread) => (
        <ThreadRow
          key={buildThreadIdentityKey(thread.source, thread.id)}
          includeLinkedDirectories
          selectedThreadKey={props.selectedThreadKey}
          thinkingThreadKeys={props.thinkingThreadKeys}
          thread={thread}
          onOpenContextMenu={props.onOpenThreadContextMenu}
          onSelectThread={props.onSelectThread}
        />
      ))}
    </div>
  );
}
