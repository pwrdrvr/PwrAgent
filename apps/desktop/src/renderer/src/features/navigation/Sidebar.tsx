import { useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  BackendSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import type { BrowseMode } from "../../lib/useThreadNavigation";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { DirectoriesList } from "./DirectoriesList";
import { InboxList } from "./InboxList";
import { RecentsList } from "./RecentsList";

type SidebarProps = {
  backends: BackendSummary[];
  browseMode: BrowseMode;
  createThreadError?: string;
  directories: NavigationDirectorySummary[];
  error?: string;
  inboxThreads: NavigationThreadSummary[];
  loading: boolean;
  creatingThread?: {
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  };
  launchpadError?: string;
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onCreateThread: (
    backend: AppServerBackendKind,
    executionMode?: ThreadExecutionMode
  ) => Promise<void>;
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
};

export function Sidebar(props: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const createThreadOptions = useMemo(
    () =>
      props.backends.flatMap((backend) =>
        backend.executionModes.map((mode) => ({
          backend,
          mode,
          enabled:
            backend.available &&
            backend.capabilities.createThread &&
            mode.available,
          helperText:
            backend.available && backend.capabilities.createThread
              ? mode.available
                ? "Ready"
                : mode.unavailableReason ?? "Unavailable"
              : backend.available
                ? "Thread creation unavailable"
                : backend.unavailableReason ?? "Unavailable",
        }))
      ),
    [props.backends]
  );
  const hasCreateThreadOptions = createThreadOptions.some((option) => option.enabled);

  return (
    <aside className="sidebar" aria-label="Threads">
      <header className="sidebar__masthead">
        <p className="eyebrow sidebar__brand">PwrAgnt</p>

        <div className="sidebar__masthead-actions">
          <div className="sidebar__new-thread">
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="button button--primary"
              disabled={!hasCreateThreadOptions || Boolean(props.creatingThread)}
              type="button"
              onClick={() => {
                setMenuOpen((current) => !current);
              }}
            >
              {props.creatingThread
                ? `Starting ${formatBackendLabel(props.creatingThread.backend)}...`
                : "New thread"}
            </button>

            {menuOpen ? (
              <div className="sidebar__menu" role="menu" aria-label="New thread backend">
                {createThreadOptions.map(({ backend, mode, enabled, helperText }) => (
                  <button
                    key={`${backend.kind}:${mode.mode}`}
                    aria-label={`Create thread with ${formatBackendLabel(
                      backend.kind
                    )} in ${formatExecutionModeLabel(mode.mode)}`}
                    className="sidebar__menu-item"
                    disabled={!enabled || Boolean(props.creatingThread)}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      void props.onCreateThread(backend.kind, mode.mode);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="sidebar__menu-item-title">
                      {formatBackendLabel(backend.kind)} · {formatExecutionModeLabel(mode.mode)}
                    </span>
                    <span className="sidebar__menu-item-detail">{helperText}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {props.createThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.createThreadError}</p>
      ) : props.launchpadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.launchpadError}</p>
      ) : null}

      <section className="sidebar__section sidebar__section--fill" aria-label="Thread browser">
        <div className="lens-switch" role="tablist" aria-label="Thread lenses">
          {(["inbox", "recents", "directories"] as const).map((mode) => (
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

        <div className="sidebar__scroll-region">
          {props.loading ? (
            <p className="sidebar-empty">Loading threads…</p>
          ) : props.error ? (
            <p className="sidebar-error">{props.error}</p>
          ) : props.browseMode === "inbox" ? (
            <InboxList
              selectedThreadKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.inboxThreads}
              onSelectThread={props.onSelectThread}
            />
          ) : props.browseMode === "directories" ? (
            <DirectoriesList
              directories={props.directories}
              selectedItemKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.threads}
              onOpenLaunchpad={props.onOpenLaunchpad}
              onSelectThread={props.onSelectThread}
            />
          ) : (
            props.threads.length === 0 ? (
              <p className="sidebar-empty">No threads yet.</p>
            ) : (
              <RecentsList
                selectedThreadKey={props.selectedItemKey}
                thinkingThreadKeys={props.thinkingThreadKeys}
                threads={props.threads}
                onSelectThread={props.onSelectThread}
              />
            )
          )}
        </div>
      </section>
    </aside>
  );
}
