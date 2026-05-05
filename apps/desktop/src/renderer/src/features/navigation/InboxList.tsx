import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { ThreadRow } from "./ThreadRow";

type InboxListProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onOpenThreadContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ) => void;
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
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
      {props.threads.map((thread) => {
        const key = buildThreadIdentityKey(thread.source, thread.id);
        return (
          <ThreadRow
            key={key}
            approvalRequestThreadKeys={props.approvalRequestThreadKeys}
            includeLinkedDirectories
            selectedThreadKey={props.selectedThreadKey}
            thinkingThreadKeys={props.thinkingThreadKeys}
            thread={thread}
            onOpenContextMenu={props.onOpenThreadContextMenu}
            onPrefetchPullRequests={props.onPrefetchPullRequests}
            onSelectThread={props.onSelectThread}
            onSetReaction={props.onSetReaction}
          />
        );
      })}
    </div>
  );
}
