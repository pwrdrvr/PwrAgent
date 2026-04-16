import type { NavigationThreadSummary } from "@pwragnt/shared";
import type { BrowseMode } from "../../lib/useThreadNavigation";
import { DirectoriesList } from "./DirectoriesList";
import { InboxList } from "./InboxList";
import { RecentsList } from "./RecentsList";

type SidebarProps = {
  browseMode: BrowseMode;
  error?: string;
  fetchedAt?: number;
  inboxThreads: NavigationThreadSummary[];
  loading: boolean;
  refreshing: boolean;
  selectedThreadId?: string;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onRefresh: () => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar__masthead">
        <div>
          <p className="eyebrow">PwrAgnt</p>
          <h1 className="sidebar__title">Threads</h1>
        </div>
        <button
          aria-label="Refresh threads"
          className="button button--ghost"
          type="button"
          onClick={() => {
            void props.onRefresh();
          }}
        >
          {props.refreshing ? "Syncing" : "Refresh"}
        </button>
      </header>

      <section className="sidebar__section">
        <div className="sidebar__section-header">
          <h2>Inbox</h2>
          <span className="count-pill">{props.inboxThreads.length}</span>
        </div>
        <InboxList
          selectedThreadId={props.selectedThreadId}
          threads={props.inboxThreads}
          onSelectThread={props.onSelectThread}
        />
      </section>

      <section className="sidebar__section sidebar__section--fill">
        <div className="sidebar__section-header">
          <div>
            <h2>Browse</h2>
            <p className="sidebar__supporting-text">
              {props.threads.length} threads
              {props.fetchedAt ? ` • ${formatTimestamp(props.fetchedAt)}` : ""}
            </p>
          </div>

          <div className="lens-switch" role="tablist" aria-label="Thread lenses">
            {(["recents", "directories"] as const).map((mode) => (
              <button
                key={mode}
                aria-pressed={props.browseMode === mode}
                className={`lens-switch__button${
                  props.browseMode === mode ? " is-active" : ""
                }`}
                type="button"
                onClick={() => props.onBrowseModeChange(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {props.loading ? (
          <p className="sidebar-empty">Loading Codex threads…</p>
        ) : props.error ? (
          <p className="sidebar-error">{props.error}</p>
        ) : props.threads.length === 0 ? (
          <p className="sidebar-empty">Codex returned zero threads.</p>
        ) : props.browseMode === "directories" ? (
          <DirectoriesList
            selectedThreadId={props.selectedThreadId}
            threads={props.threads}
            onSelectThread={props.onSelectThread}
          />
        ) : (
          <RecentsList
            selectedThreadId={props.selectedThreadId}
            threads={props.threads}
            onSelectThread={props.onSelectThread}
          />
        )}
      </section>
    </aside>
  );
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}
