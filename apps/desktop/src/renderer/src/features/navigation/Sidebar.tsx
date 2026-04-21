import { useEffect, useMemo, useState } from "react";
import type {
  AppServerBackendKind,
  BackendSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import type { BrowseMode } from "../../lib/useThreadNavigation";
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
  archiveThreadError?: string;
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onCreateThread: () => Promise<void>;
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onArchiveThread?: (thread: NavigationThreadSummary) => Promise<void>;
};

export function Sidebar(props: SidebarProps) {
  const [confirmArchiveThread, setConfirmArchiveThread] =
    useState<NavigationThreadSummary>();
  const [contextMenu, setContextMenu] = useState<
    | {
        position: { x: number; y: number };
        thread: NavigationThreadSummary;
      }
    | undefined
  >();
  const hasCreateThreadOptions = useMemo(
    () =>
      props.backends.some(
        (backend) =>
          backend.available &&
          backend.capabilities.createThread &&
          backend.executionModes.some((mode) => mode.available)
      ),
    [props.backends]
  );
  const onArchiveThread = props.onArchiveThread ?? (async () => undefined);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeMenu = (): void => setContextMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const requestArchiveWithConfirmation = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    setConfirmArchiveThread(thread);
  };

  const openThreadContextMenu = (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ): void => {
    setConfirmArchiveThread(undefined);
    setContextMenu({ position, thread });
  };

  const archiveFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    void onArchiveThread(thread);
  };

  const confirmArchive = (): void => {
    if (!confirmArchiveThread) {
      return;
    }

    const thread = confirmArchiveThread;
    setConfirmArchiveThread(undefined);
    void onArchiveThread(thread);
  };

  return (
    <aside className="sidebar" aria-label="Threads">
      <header className="sidebar__masthead">
        <p className="eyebrow sidebar__brand">PwrAgnt</p>

        <div className="sidebar__masthead-actions">
          <div className="sidebar__new-thread">
            <button
              className="button button--primary"
              disabled={!hasCreateThreadOptions || Boolean(props.creatingThread)}
              type="button"
              onClick={() => {
                void props.onCreateThread();
              }}
            >
              {props.creatingThread ? "Opening..." : "New thread"}
            </button>
          </div>
        </div>
      </header>

      {props.createThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.createThreadError}</p>
      ) : props.launchpadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.launchpadError}</p>
      ) : props.archiveThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.archiveThreadError}</p>
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
              onOpenThreadContextMenu={openThreadContextMenu}
              onRequestArchiveThread={requestArchiveWithConfirmation}
              onSelectThread={props.onSelectThread}
            />
          ) : props.browseMode === "directories" ? (
            <DirectoriesList
              directories={props.directories}
              selectedItemKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.threads}
              onOpenThreadContextMenu={openThreadContextMenu}
              onOpenLaunchpad={props.onOpenLaunchpad}
              onRequestArchiveThread={requestArchiveWithConfirmation}
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
                onOpenThreadContextMenu={openThreadContextMenu}
                onRequestArchiveThread={requestArchiveWithConfirmation}
                onSelectThread={props.onSelectThread}
              />
            )
          )}
        </div>
      </section>

      {contextMenu ? (
        <div
          className="thread-context-menu"
          role="menu"
          style={{
            left: contextMenu.position.x,
            top: contextMenu.position.y,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => archiveFromContextMenu(contextMenu.thread)}
          >
            Archive Thread
          </button>
        </div>
      ) : null}

      {confirmArchiveThread ? (
        <div className="archive-confirmation-backdrop" role="presentation">
          <section
            aria-labelledby="archive-confirmation-title"
            aria-modal="true"
            className="archive-confirmation-dialog"
            role="dialog"
          >
            <h2 id="archive-confirmation-title">Archive Thread</h2>
            <p>
              Archive this thread and delete its worktree? Any uncommitted files in
              that worktree will be removed.
            </p>
            <div className="archive-confirmation-actions">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setConfirmArchiveThread(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="button"
                onClick={confirmArchive}
              >
                Archive Thread
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
