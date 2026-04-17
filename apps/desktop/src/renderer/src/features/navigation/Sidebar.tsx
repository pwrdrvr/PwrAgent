import { useMemo, useState } from "react";
import type { AppServerBackendKind, BackendSummary, NavigationThreadSummary } from "@pwragnt/shared";
import type { BrowseMode } from "../../lib/useThreadNavigation";
import { formatBackendLabel } from "../../lib/backend-label";
import { DirectoriesList } from "./DirectoriesList";
import { InboxList } from "./InboxList";
import { RecentsList } from "./RecentsList";

type SidebarProps = {
  backends: BackendSummary[];
  browseMode: BrowseMode;
  createThreadError?: string;
  error?: string;
  fetchedAt?: number;
  inboxThreads: NavigationThreadSummary[];
  loading: boolean;
  creatingThreadBackend?: AppServerBackendKind;
  refreshing: boolean;
  selectedThreadKey?: string;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onCreateThread: (backend: AppServerBackendKind) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function Sidebar(props: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const createThreadOptions = useMemo(
    () =>
      props.backends.map((backend) => ({
        backend,
        enabled: backend.available && backend.capabilities.createThread,
        helperText: backend.available
          ? backend.capabilities.createThread
            ? "Ready"
            : "Thread creation unavailable"
          : backend.unavailableReason ?? "Unavailable",
      })),
    [props.backends],
  );
  const hasCreateThreadOptions = createThreadOptions.some((option) => option.enabled);

  return (
    <aside className="sidebar">
      <header className="sidebar__masthead">
        <div>
          <p className="eyebrow">PwrAgnt</p>
          <h1 className="sidebar__title">Threads</h1>
        </div>

        <div className="sidebar__masthead-actions">
          <div className="sidebar__new-thread">
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="button button--primary"
              disabled={!hasCreateThreadOptions || Boolean(props.creatingThreadBackend)}
              type="button"
              onClick={() => {
                setMenuOpen((current) => !current);
              }}
            >
              {props.creatingThreadBackend
                ? `Starting ${formatBackendLabel(props.creatingThreadBackend)}...`
                : "New thread"}
            </button>

            {menuOpen ? (
              <div className="sidebar__menu" role="menu" aria-label="New thread backend">
                {createThreadOptions.map(({ backend, enabled, helperText }) => (
                  <button
                    key={backend.kind}
                    aria-label={`Create thread with ${formatBackendLabel(backend.kind)}`}
                    className="sidebar__menu-item"
                    disabled={!enabled || Boolean(props.creatingThreadBackend)}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      void props.onCreateThread(backend.kind);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="sidebar__menu-item-title">
                      {formatBackendLabel(backend.kind)}
                    </span>
                    <span className="sidebar__menu-item-detail">{helperText}</span>
                  </button>
                ))}
              </div>
            ) : null}
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
        </div>
      </header>

      {props.createThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.createThreadError}</p>
      ) : null}

      <section className="sidebar__section">
        <div className="sidebar__section-header">
          <h2>Inbox</h2>
          <span className="count-pill">{props.inboxThreads.length}</span>
        </div>
        <InboxList
          selectedThreadKey={props.selectedThreadKey}
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

        <div className="sidebar__scroll-region">
          {props.loading ? (
            <p className="sidebar-empty">Loading threads…</p>
          ) : props.error ? (
            <p className="sidebar-error">{props.error}</p>
          ) : props.threads.length === 0 ? (
            <p className="sidebar-empty">No threads yet.</p>
          ) : props.browseMode === "directories" ? (
            <DirectoriesList
              selectedThreadKey={props.selectedThreadKey}
              threads={props.threads}
              onSelectThread={props.onSelectThread}
            />
          ) : (
            <RecentsList
              selectedThreadKey={props.selectedThreadKey}
              threads={props.threads}
              onSelectThread={props.onSelectThread}
            />
          )}
        </div>
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
