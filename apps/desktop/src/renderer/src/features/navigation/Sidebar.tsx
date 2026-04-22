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
  renameThreadError?: string;
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
  onRenameThread?: (thread: NavigationThreadSummary, name: string) => Promise<void>;
};

export function Sidebar(props: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<
    | {
        position: { x: number; y: number };
        thread: NavigationThreadSummary;
      }
    | undefined
  >();
  const [renameThread, setRenameThread] = useState<NavigationThreadSummary>();
  const [renameDraft, setRenameDraft] = useState("");
  const [renameValidationError, setRenameValidationError] = useState<string>();
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
  const onRenameThread = props.onRenameThread ?? (async () => undefined);

  const canRenameThread = (thread: NavigationThreadSummary): boolean =>
    props.backends.some(
      (backend) =>
        backend.kind === thread.source &&
        backend.available &&
        backend.capabilities.renameThread
    );

  const canArchiveThread = (thread: NavigationThreadSummary): boolean =>
    props.backends.some(
      (backend) =>
        backend.kind === thread.source &&
        backend.available &&
        backend.capabilities.archiveThread === true
    );

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

  const openThreadContextMenu = (
    thread: NavigationThreadSummary,
    position: { x: number; y: number }
  ): void => {
    setRenameThread(undefined);
    setContextMenu({ position, thread });
  };

  const requestRenameFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    setRenameThread(thread);
    setRenameDraft(thread.title);
    setRenameValidationError(undefined);
  };

  const archiveFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    void onArchiveThread(thread);
  };

  const submitRename = (): void => {
    if (!renameThread) {
      return;
    }

    const nextName = renameDraft.trim();
    if (!nextName) {
      setRenameValidationError("Thread name cannot be blank.");
      return;
    }

    const thread = renameThread;
    setRenameThread(undefined);
    setRenameValidationError(undefined);
    void onRenameThread(thread, nextName);
  };

  const contextMenuCanRename = contextMenu
    ? canRenameThread(contextMenu.thread)
    : false;
  const contextMenuCanArchive = contextMenu
    ? canArchiveThread(contextMenu.thread)
    : false;

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
      ) : props.renameThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.renameThreadError}</p>
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
                onSelectThread={props.onSelectThread}
              />
            )
          )}
        </div>
      </section>

      {contextMenu && (contextMenuCanRename || contextMenuCanArchive) ? (
        <div
          className="thread-context-menu"
          role="menu"
          style={{
            left: contextMenu.position.x,
            top: contextMenu.position.y,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenuCanRename ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => requestRenameFromContextMenu(contextMenu.thread)}
            >
              Rename Thread
            </button>
          ) : null}
          {contextMenuCanArchive ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => archiveFromContextMenu(contextMenu.thread)}
            >
              Archive Thread
            </button>
          ) : null}
        </div>
      ) : null}

      {renameThread ? (
        <div className="rename-thread-backdrop" role="presentation">
          <section
            aria-labelledby="rename-thread-title"
            aria-modal="true"
            className="rename-thread-dialog"
            role="dialog"
          >
            <h2 id="rename-thread-title">Rename Thread</h2>
            <label className="rename-thread-dialog__field">
              <span>Name</span>
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => {
                  setRenameDraft(event.currentTarget.value);
                  setRenameValidationError(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setRenameThread(undefined);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    submitRename();
                  }
                }}
              />
            </label>
            {renameValidationError ? (
              <p className="rename-thread-dialog__error">{renameValidationError}</p>
            ) : null}
            <div className="rename-thread-dialog__actions">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setRenameThread(undefined)}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="button"
                onClick={submitRename}
              >
                Rename Thread
              </button>
            </div>
          </section>
        </div>
      ) : null}

    </aside>
  );
}
