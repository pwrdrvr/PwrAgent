import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent } from "react";
import type {
  AppServerBackendKind,
  BackendSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import type { RuntimeIdentity } from "../../../../shared/runtime-identity";
import { copyText } from "../../lib/copy-text";
import { BranchIcon, FolderIcon } from "../../icons";
import type { BrowseMode } from "../../lib/useThreadNavigation";
import {
  formatRuntimeGitRef,
  formatRuntimePath,
  runtimeGitRefCopyValue,
} from "../../lib/runtime-identity";
import { DirectoriesList } from "./DirectoriesList";
import { InboxList } from "./InboxList";
import { RecentsList } from "./RecentsList";

type ThreadContextMenuPosition = {
  x: number;
  y: number;
  anchorTop?: number;
};

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
  runtimeIdentity?: RuntimeIdentity;
  settingsActive?: boolean;
  approvalRequestThreadKeys?: Record<string, boolean>;
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onCreateThread: () => Promise<void>;
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onOpenSettings?: () => void;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onArchiveThread?: (thread: NavigationThreadSummary) => Promise<void>;
  onRenameThread?: (thread: NavigationThreadSummary, name: string) => Promise<void>;
  onSetThreadReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onResizeStart?: (event: PointerEvent<HTMLElement>) => void;
  onResizeByKeyboard?: (delta: number) => void;
};

export function Sidebar(props: SidebarProps) {
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<
    | {
        requestedPosition: ThreadContextMenuPosition;
        position?: { x: number; y: number };
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
  const [copiedRuntimeValue, setCopiedRuntimeValue] = useState<"branch" | "cwd">();
  const runtimeGitRefLabel = props.runtimeIdentity
    ? formatRuntimeGitRef(props.runtimeIdentity)
    : undefined;
  const runtimeGitRefValue = props.runtimeIdentity
    ? runtimeGitRefCopyValue(props.runtimeIdentity)
    : undefined;

  useEffect(() => {
    if (!copiedRuntimeValue) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedRuntimeValue(undefined);
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [copiedRuntimeValue]);

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

  useLayoutEffect(() => {
    if (!contextMenu) {
      return;
    }

    const menu = contextMenuRef.current;
    if (!menu) {
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    const nextPosition = placeThreadContextMenu(
      contextMenu.requestedPosition,
      menuRect
    );

    if (
      contextMenu.position?.x === nextPosition.x &&
      contextMenu.position.y === nextPosition.y
    ) {
      return;
    }

    setContextMenu({
      ...contextMenu,
      position: nextPosition,
    });
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!renameThread) {
      return;
    }

    const input = renameInputRef.current;
    input?.focus();
    input?.select();
  }, [renameThread]);

  const openThreadContextMenu = (
    thread: NavigationThreadSummary,
    position: ThreadContextMenuPosition
  ): void => {
    setRenameThread(undefined);
    setContextMenu({ requestedPosition: position, thread });
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

  const copyFromContextMenu = (value: string): void => {
    setContextMenu(undefined);
    void copyText(value);
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
  const contextMenuLocalPath = contextMenu?.thread.linkedDirectories.find(
    (directory) => directory.kind === "local"
  )?.path;
  const contextMenuWorktreePath = contextMenu?.thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree"
  );
  const contextMenuWorktreeCopyPath =
    contextMenuWorktreePath?.worktreePath ?? contextMenuWorktreePath?.path;
  const contextMenuBranchName = contextMenu?.thread.gitBranch;
  const contextMenuHasTopActions = contextMenuCanRename || contextMenuCanArchive;

  return (
    <aside className="sidebar" aria-label="Threads">
      <div
        aria-label="Resize thread sidebar"
        aria-orientation="vertical"
        className="sidebar__resize-handle"
        role="separator"
        tabIndex={0}
        onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            props.onResizeByKeyboard?.(-16);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            props.onResizeByKeyboard?.(16);
          }
        }}
        onPointerDown={props.onResizeStart}
      />
      <header className="sidebar__masthead">
        <p className="sidebar__brand">Pwr<span className="sidebar__brand-accent">Agent</span></p>

        <div className="sidebar__masthead-actions">
          <button
            aria-label="Open settings"
            aria-pressed={props.settingsActive}
            className={`sidebar__icon-button${props.settingsActive ? " is-active" : ""}`}
            type="button"
            onClick={props.onOpenSettings}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button
            aria-label="New thread"
            className="sidebar__icon-button"
            disabled={!hasCreateThreadOptions || Boolean(props.creatingThread)}
            type="button"
            onClick={() => {
              void props.onCreateThread();
            }}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
          </button>
        </div>
      </header>

      {props.runtimeIdentity ? (
        <div className="runtime-identity" aria-label="Runtime identity">
          <RuntimeIdentityButton
            copied={copiedRuntimeValue === "cwd"}
            label={formatRuntimePath(props.runtimeIdentity.cwd)}
            value={props.runtimeIdentity.cwd}
            valueKind="cwd"
            onCopied={setCopiedRuntimeValue}
          />
          {runtimeGitRefLabel && runtimeGitRefValue ? (
            <RuntimeIdentityButton
              copied={copiedRuntimeValue === "branch"}
              copyLabel={
                props.runtimeIdentity.detachedHead ? "commit SHA" : "branch name"
              }
              label={runtimeGitRefLabel}
              value={runtimeGitRefValue}
              valueKind="branch"
              onCopied={setCopiedRuntimeValue}
            />
          ) : null}
        </div>
      ) : null}

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
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              selectedThreadKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.inboxThreads}
              onOpenThreadContextMenu={openThreadContextMenu}
              onSelectThread={props.onSelectThread}
              onSetReaction={props.onSetThreadReaction}
            />
          ) : props.browseMode === "directories" ? (
            <DirectoriesList
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              directories={props.directories}
              selectedItemKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.threads}
              onOpenThreadContextMenu={openThreadContextMenu}
              onOpenLaunchpad={props.onOpenLaunchpad}
              onSelectThread={props.onSelectThread}
              onSetReaction={props.onSetThreadReaction}
            />
          ) : (
            props.threads.length === 0 ? (
              <p className="sidebar-empty">No threads yet.</p>
            ) : (
              <RecentsList
                approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                selectedThreadKey={props.selectedItemKey}
                thinkingThreadKeys={props.thinkingThreadKeys}
                threads={props.threads}
                onOpenThreadContextMenu={openThreadContextMenu}
                onSelectThread={props.onSelectThread}
                onSetReaction={props.onSetThreadReaction}
              />
            )
          )}
        </div>
      </section>

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="thread-context-menu"
          role="menu"
          style={{
            left: contextMenu.position?.x ?? contextMenu.requestedPosition.x,
            top: contextMenu.position?.y ?? contextMenu.requestedPosition.y,
            visibility: contextMenu.position ? undefined : "hidden",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenuHasTopActions ? (
            <div className="thread-context-menu__section">
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
          {contextMenuHasTopActions ? (
            <div className="thread-context-menu__separator" role="separator" />
          ) : null}
          <div className="thread-context-menu__section">
            <button
              role="menuitem"
              type="button"
              onClick={() => copyFromContextMenu(contextMenu.thread.id)}
            >
              Copy Thread ID
            </button>
            {contextMenuWorktreeCopyPath ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => copyFromContextMenu(contextMenuWorktreeCopyPath)}
              >
                Copy Worktree Path
              </button>
            ) : null}
            {contextMenuLocalPath ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => copyFromContextMenu(contextMenuLocalPath)}
              >
                Copy Local Path
              </button>
            ) : null}
            {contextMenuBranchName ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => copyFromContextMenu(contextMenuBranchName)}
              >
                Copy Branch Name
              </button>
            ) : null}
          </div>
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
                ref={renameInputRef}
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
                  } else if (
                    (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey &&
                    event.currentTarget.selectionStart === 0 &&
                    event.currentTarget.selectionEnd === event.currentTarget.value.length
                  ) {
                    event.preventDefault();
                    const nextPosition =
                      event.key === "ArrowLeft" ? 0 : event.currentTarget.value.length;
                    event.currentTarget.setSelectionRange(nextPosition, nextPosition);
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

function placeThreadContextMenu(
  requestedPosition: ThreadContextMenuPosition,
  menuRect: DOMRect
): { x: number; y: number } {
  const viewportMargin = 8;
  const triggerGap = 4;
  const menuWidth = menuRect.width || 168;
  const menuHeight = menuRect.height;
  const maxX = window.innerWidth - menuWidth - viewportMargin;
  const maxY = window.innerHeight - menuHeight - viewportMargin;

  const belowTop = requestedPosition.y;
  const wouldOverflowBottom =
    menuHeight > 0 && belowTop + menuHeight + viewportMargin > window.innerHeight;
  const flippedTop =
    requestedPosition.anchorTop !== undefined
      ? requestedPosition.anchorTop - menuHeight - triggerGap
      : requestedPosition.y - menuHeight - triggerGap;

  return {
    x: Math.max(viewportMargin, Math.min(requestedPosition.x, maxX)),
    y: Math.max(
      viewportMargin,
      Math.min(wouldOverflowBottom ? flippedTop : belowTop, maxY)
    ),
  };
}

function RuntimeIdentityButton(props: {
  copied: boolean;
  copyLabel?: string;
  label: string;
  value: string;
  valueKind: "branch" | "cwd";
  onCopied: (valueKind: "branch" | "cwd") => void;
}) {
  return (
    <button
      aria-label={`Copy ${
        props.copyLabel ?? (props.valueKind === "cwd" ? "working directory" : "branch name")
      }`}
      className="runtime-identity__button path-copy-target tooltip-target"
      data-tooltip={
        props.copied
          ? "Copied"
          : `${props.value}\nClick to copy to clipboard`
      }
      type="button"
      onClick={() => {
        void copyText(props.value).then(() => props.onCopied(props.valueKind));
      }}
    >
      <span aria-hidden="true" className="runtime-identity__icon">
        {props.valueKind === "cwd" ? <FolderIcon size={13} /> : <BranchIcon size={13} />}
      </span>
      <span className="runtime-identity__text">{props.label}</span>
    </button>
  );
}
