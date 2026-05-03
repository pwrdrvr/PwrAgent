import type { NavigationThreadSummary } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { ThreadRow } from "./ThreadRow";

type RecentsListProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onOpenThreadContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ) => void;
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function RecentsList(props: RecentsListProps) {
  return (
    <div className="sidebar-list sidebar-list--dense" role="list">
      {props.threads.map((thread) => (
        <ThreadRow
          key={buildThreadIdentityKey(thread.source, thread.id)}
          approvalRequestThreadKeys={props.approvalRequestThreadKeys}
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
