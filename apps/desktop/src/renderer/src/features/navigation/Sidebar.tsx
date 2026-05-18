import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent,
} from "react";
import type {
  AppServerBackendKind,
  BackendSummary,
  DesktopPwrAgentProfileSummary,
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  comparePinnedDirectories,
  comparePinnedThreads,
  isPinnedDirectory,
  isPinnedThread,
  moveDirectoryKey,
  moveThreadKey,
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
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  formatRateLimitLine,
  selectVisibleRateLimits,
} from "../../lib/backend-status-format";
import { DirectoriesList } from "./DirectoriesList";
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
  inboxThreads?: NavigationThreadSummary[];
  recentThreads?: NavigationThreadSummary[];
  loading: boolean;
  creatingThread?: {
    backend: AppServerBackendKind;
    executionMode: ThreadExecutionMode;
  };
  launchpadError?: string;
  archiveThreadError?: string;
  renameThreadError?: string;
  runtimeIdentity?: RuntimeIdentity;
  activeProfile?: string;
  profiles?: DesktopPwrAgentProfileSummary[];
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
  onOpenProfile?: (profile: string) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onArchiveThread?: (thread: NavigationThreadSummary) => Promise<void>;
  onRenameThread?: (thread: NavigationThreadSummary, name: string) => Promise<void>;
  onSetThreadReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onSetThreadPin?: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  onReorderThreadPins?: (
    backend: AppServerBackendKind,
    threadIds: string[],
  ) => Promise<void>;
  /**
   * Directory pinning (plan 2026-05-09-002). Mirror of thread-pin
   * props minus the per-backend dimension. Both must be provided
   * for the DirectoriesList to render the pinned section + accept
   * drag-pin gestures; passing only one (e.g. testing) leaves the
   * other path as a no-op.
   */
  onSetDirectoryPin?: (
    directory: NavigationDirectorySummary,
    pinned: boolean,
  ) => Promise<void>;
  onReorderDirectoryPins?: (directoryKeys: string[]) => Promise<void>;
  /**
   * Called by thread rows when the user hovers a non-merged PR chip
   * (or the row itself, depending on chip strategy). Used to prefetch
   * fresh PR status before they click in.
   */
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  /**
   * Called when the user unbinds a messaging conversation from a
   * thread via the binding chip. Receives the thread + binding so the
   * parent can call the IPC and refresh navigation.
   */
  onUnbindMessagingBinding?: (
    thread: NavigationThreadSummary,
    binding: MessagingThreadBindingSummary,
  ) => Promise<void>;
  onResizeStart?: (event: PointerEvent<HTMLElement>) => void;
  onResizeByKeyboard?: (delta: number) => void;
  /**
   * Current sidebar width and clamp range, plumbed in so the resize
   * handle can expose aria-valuenow / aria-valuemin / aria-valuemax —
   * required by axe-core for focusable role="separator". All three are
   * optional so older callers (and unit tests that mount Sidebar in
   * isolation) keep compiling; the handle silently omits the aria-value*
   * attributes when they're absent.
   */
  sidebarWidth?: number;
  sidebarMinWidth?: number;
  sidebarMaxWidth?: number;
};

const browseModeLabels = {
  inbox: "Updated",
  recents: "Created",
  directories: "Directories",
} satisfies Record<BrowseMode, string>;

export function Sidebar(props: SidebarProps) {
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const directoryContextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<
    | {
        requestedPosition: ThreadContextMenuPosition;
        position?: { x: number; y: number };
        thread: NavigationThreadSummary;
      }
    | undefined
  >();
  /**
   * Directory context menu — parallel to `contextMenu` (the thread
   * context menu) but only carries a "Pin Directory" / "Unpin
   * Directory" action today. Kept as its own state instead of
   * polymorphizing the thread menu because the thread menu has many
   * thread-shaped actions (Rename / Archive / Copy / Unbind) that
   * don't make sense on directories. Plan 2026-05-09-002 Unit M.
   */
  const [directoryContextMenu, setDirectoryContextMenu] = useState<
    | {
        requestedPosition: ThreadContextMenuPosition;
        position?: { x: number; y: number };
        directory: NavigationDirectorySummary;
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
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const runtimeGitRefLabel = props.runtimeIdentity
    ? formatRuntimeGitRef(props.runtimeIdentity)
    : undefined;
  const runtimeGitRefValue = props.runtimeIdentity
    ? runtimeGitRefCopyValue(props.runtimeIdentity)
    : undefined;
  const currentActiveProfile = props.activeProfile
    ? props.profiles?.find((profile) => profile.active)
      ?? props.profiles?.find((profile) => profile.name === props.activeProfile)
    : undefined;
  const [startupActiveProfile, setStartupActiveProfile] =
    useState<DesktopPwrAgentProfileSummary>();
  useEffect(() => {
    if (!startupActiveProfile && currentActiveProfile) {
      setStartupActiveProfile(currentActiveProfile);
    }
  }, [currentActiveProfile, startupActiveProfile]);
  const activeProfile = startupActiveProfile ?? currentActiveProfile;
  const codexBackend = props.backends.find((backend) => backend.kind === "codex");
  const profileLabel = props.activeProfile
    ? formatProfileIdentityLabel(props.activeProfile, activeProfile)
    : undefined;
  const profileTooltip = props.activeProfile
    ? formatProfileIdentityTooltip({
      activeProfile: props.activeProfile,
      codexBackend,
      profile: activeProfile,
    })
    : undefined;
  const visibleThreads =
    props.browseMode === "recents"
      ? props.recentThreads ?? props.threads
      : props.inboxThreads ?? props.threads;

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

  useEffect(() => {
    if (!directoryContextMenu) {
      return;
    }

    const closeMenu = (): void => setDirectoryContextMenu(undefined);
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
  }, [directoryContextMenu]);

  useEffect(() => {
    if (!profileMenuOpen) {
      return;
    }

    const closeMenu = (): void => setProfileMenuOpen(false);
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
  }, [profileMenuOpen]);

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
    if (!directoryContextMenu) {
      return;
    }

    const menu = directoryContextMenuRef.current;
    if (!menu) {
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    const nextPosition = placeThreadContextMenu(
      directoryContextMenu.requestedPosition,
      menuRect,
    );

    if (
      directoryContextMenu.position?.x === nextPosition.x &&
      directoryContextMenu.position.y === nextPosition.y
    ) {
      return;
    }

    setDirectoryContextMenu({
      ...directoryContextMenu,
      position: nextPosition,
    });
  }, [directoryContextMenu]);

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
    // Symmetric with `openDirectoryContextMenu`'s
    // `setContextMenu(undefined)` — a `contextmenu` event doesn't
    // trigger the document-level `click` listener that normally
    // dismisses menus, so without this explicit clear a user could
    // right-click a directory and then right-click a thread and
    // see both menus stacked on top of each other.
    setDirectoryContextMenu(undefined);
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

  const togglePinFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    void props.onSetThreadPin?.(thread, !thread.pinnedRank);
  };

  const openDirectoryContextMenu = (
    directory: NavigationDirectorySummary,
    position: ThreadContextMenuPosition,
  ): void => {
    setContextMenu(undefined);
    setRenameThread(undefined);
    setDirectoryContextMenu({ requestedPosition: position, directory });
  };

  const togglePinDirectoryFromContextMenu = (
    directory: NavigationDirectorySummary,
  ): void => {
    setDirectoryContextMenu(undefined);
    void props.onSetDirectoryPin?.(directory, !directory.pinnedRank);
  };

  /**
   * Pinned-thread order, grouped by backend. The thread reorder
   * IPC is per-backend (mirrors per-backend pin ranks), so the
   * "Move Up / Move Down" menu items have to compute per-backend
   * adjacency to figure out whether the target row is at the top
   * or bottom of its backend's pinned section.
   */
  const pinnedThreadIdsByBackend = useMemo(() => {
    const byBackend = new Map<AppServerBackendKind, string[]>();
    for (const thread of [...props.threads]
      .filter(isPinnedThread)
      .sort(comparePinnedThreads)) {
      const list = byBackend.get(thread.source) ?? [];
      list.push(thread.id);
      byBackend.set(thread.source, list);
    }
    return byBackend;
  }, [props.threads]);

  /**
   * Pinned-directory keys in stable user-curated order. Directory
   * pinning is global (backend-agnostic, see plan 2026-05-09-002),
   * so a single sorted array is enough to compute Move Up / Move
   * Down adjacency for the directory context menu.
   */
  const pinnedDirectoryKeysInOrder = useMemo(
    () =>
      [...props.directories]
        .filter(isPinnedDirectory)
        .sort(comparePinnedDirectories)
        .map((directory) => directory.key),
    [props.directories],
  );

  const moveThreadFromContextMenu = (
    thread: NavigationThreadSummary,
    direction: "up" | "down",
  ): void => {
    const ordered = pinnedThreadIdsByBackend.get(thread.source) ?? [];
    const currentIndex = ordered.indexOf(thread.id);
    if (currentIndex === -1) return;
    const targetIndex =
      direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= ordered.length) return;
    const targetId = ordered[targetIndex]!;
    const nextIds = moveThreadKey(
      ordered,
      thread.id,
      targetId,
      direction === "up" ? "before" : "after",
    );
    // Intentionally do NOT dismiss the menu after a Move — the
    // user often wants several reorder taps in a row, and
    // re-right-clicking between every one is a UX downgrade vs
    // the keyboard shortcut. The menu re-renders with fresh
    // `pinnedThreadIdsByBackend` on the snapshot reconciliation
    // tick, so subsequent Move clicks see updated adjacency.
    // Pin / Unpin / Rename / Archive are terminal actions and
    // still dismiss the menu.
    void props.onReorderThreadPins?.(thread.source, nextIds);
  };

  const moveDirectoryFromContextMenu = (
    directory: NavigationDirectorySummary,
    direction: "up" | "down",
  ): void => {
    const ordered = pinnedDirectoryKeysInOrder;
    const currentIndex = ordered.indexOf(directory.key);
    if (currentIndex === -1) return;
    const targetIndex =
      direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= ordered.length) return;
    const targetKey = ordered[targetIndex]!;
    const nextKeys = moveDirectoryKey(
      ordered,
      directory.key,
      targetKey,
      direction === "up" ? "before" : "after",
    );
    // See `moveThreadFromContextMenu` for why we don't dismiss
    // the menu here.
    void props.onReorderDirectoryPins?.(nextKeys);
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
  const contextMenuCanPin = Boolean(contextMenu && props.onSetThreadPin);
  /**
   * Move Up / Move Down show as menu items only when the target
   * thread is pinned (reorder only applies inside the pinned
   * section) AND the reorder IPC is wired. Each item is then
   * disabled when the thread is at the top / bottom of its
   * backend's pinned slice. We render the items even when disabled
   * so the menu layout doesn't jump as the user walks the list.
   */
  const contextMenuShowMoveItems = Boolean(
    contextMenu?.thread.pinnedRank && props.onReorderThreadPins,
  );
  const contextMenuPinnedThreadIndex = contextMenu
    ? (pinnedThreadIdsByBackend.get(contextMenu.thread.source) ?? []).indexOf(
        contextMenu.thread.id,
      )
    : -1;
  const contextMenuPinnedThreadCount = contextMenu
    ? (pinnedThreadIdsByBackend.get(contextMenu.thread.source) ?? []).length
    : 0;
  const contextMenuCanMoveUp =
    contextMenuShowMoveItems && contextMenuPinnedThreadIndex > 0;
  const contextMenuCanMoveDown =
    contextMenuShowMoveItems &&
    contextMenuPinnedThreadIndex >= 0 &&
    contextMenuPinnedThreadIndex < contextMenuPinnedThreadCount - 1;
  const contextMenuHasTopActions =
    contextMenuCanPin ||
    contextMenuShowMoveItems ||
    contextMenuCanRename ||
    contextMenuCanArchive;

  // Same shape as the thread context menu's "Move" items, applied
  // to the directory context menu. Directory pinning is global so
  // a single sorted array drives both adjacency checks.
  const directoryMenuShowMoveItems = Boolean(
    directoryContextMenu?.directory.pinnedRank &&
      props.onReorderDirectoryPins,
  );
  const directoryMenuPinnedIndex = directoryContextMenu
    ? pinnedDirectoryKeysInOrder.indexOf(directoryContextMenu.directory.key)
    : -1;
  const directoryMenuCanMoveUp =
    directoryMenuShowMoveItems && directoryMenuPinnedIndex > 0;
  const directoryMenuCanMoveDown =
    directoryMenuShowMoveItems &&
    directoryMenuPinnedIndex >= 0 &&
    directoryMenuPinnedIndex < pinnedDirectoryKeysInOrder.length - 1;

  return (
    <aside className="sidebar" aria-label="Threads">
      <div
        aria-label="Resize thread sidebar"
        aria-orientation="vertical"
        aria-valuenow={props.sidebarWidth}
        aria-valuemin={props.sidebarMinWidth}
        aria-valuemax={props.sidebarMaxWidth}
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

      {props.activeProfile ? (
        <div className="runtime-identity" aria-label="PwrAgent profile">
          <ProfileIdentityButton
            label={profileLabel ?? `profile:${props.activeProfile}`}
            tooltipText={profileTooltip}
            onToggle={(event) => {
              event.stopPropagation();
              setProfileMenuOpen((open) => !open);
            }}
          />
          {profileMenuOpen && props.profiles?.length ? (
            <div
              className="sidebar__menu sidebar__menu--profile"
              role="menu"
              onClick={(event) => event.stopPropagation()}
            >
              {props.profiles.map((profile) => (
                <button
                  key={profile.name}
                  className="sidebar__menu-item"
                  disabled={profile.active || !props.onOpenProfile}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    void props.onOpenProfile?.(profile.name);
                  }}
                >
                  <span className="sidebar__menu-item-title">
                    {profile.displayName || profile.name}
                  </span>
                  <span className="sidebar__menu-item-detail">
                    {profile.active
                      ? profile.default
                        ? "Current profile - startup default"
                        : "Current profile"
                      : profile.default
                        ? "Startup default - open in new app instance"
                        : "Open in new app instance"}
                  </span>
                </button>
              ))}
            </div>
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
              // role="tab" + aria-selected is what makes the tablist a
              // valid ARIA composite. Keyboard nav is unchanged (Tab still
              // cycles through every button) since browsers don't auto-wire
              // arrow-key navigation from role alone — adding role here only
              // changes how screen readers announce the widget.
              role="tab"
              aria-selected={props.browseMode === mode}
              className={`lens-switch__button${
                props.browseMode === mode ? " is-active" : ""
              }`}
              type="button"
              onClick={() => props.onBrowseModeChange(mode)}
            >
              {browseModeLabels[mode]}
            </button>
          ))}
        </div>

        <div className="sidebar__scroll-region">
          {props.loading ? (
            <p className="sidebar-empty">Loading threads…</p>
          ) : props.error ? (
            <p className="sidebar-error">{props.error}</p>
          ) : props.browseMode === "directories" ? (
            <DirectoriesList
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              directories={props.directories}
              selectedItemKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.threads}
              onOpenThreadContextMenu={openThreadContextMenu}
              onOpenLaunchpad={props.onOpenLaunchpad}
              onPrefetchPullRequests={props.onPrefetchPullRequests}
              onReorderThreadPins={props.onReorderThreadPins}
              onSetDirectoryPin={props.onSetDirectoryPin}
              onReorderDirectoryPins={props.onReorderDirectoryPins}
              onOpenDirectoryContextMenu={
                props.onSetDirectoryPin ? openDirectoryContextMenu : undefined
              }
              onSelectThread={props.onSelectThread}
              onSetReaction={props.onSetThreadReaction}
              onUnbindMessagingBinding={props.onUnbindMessagingBinding}
            />
          ) : (
            visibleThreads.length === 0 ? (
              <p className="sidebar-empty">No threads yet.</p>
            ) : (
              <RecentsList
                approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                selectedThreadKey={props.selectedItemKey}
                thinkingThreadKeys={props.thinkingThreadKeys}
                threads={visibleThreads}
                onOpenThreadContextMenu={openThreadContextMenu}
                onPrefetchPullRequests={props.onPrefetchPullRequests}
                onReorderThreadPins={props.onReorderThreadPins}
                onSelectThread={props.onSelectThread}
                onSetReaction={props.onSetThreadReaction}
                onUnbindMessagingBinding={props.onUnbindMessagingBinding}
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
              {contextMenuCanPin ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => togglePinFromContextMenu(contextMenu.thread)}
                >
                  {contextMenu.thread.pinnedRank ? "Unpin Thread" : "Pin Thread"}
                </button>
              ) : null}
              {contextMenuShowMoveItems ? (
                <>
                  <button
                    role="menuitem"
                    type="button"
                    aria-keyshortcuts="Meta+Shift+ArrowUp"
                    disabled={!contextMenuCanMoveUp}
                    onClick={() =>
                      moveThreadFromContextMenu(contextMenu.thread, "up")
                    }
                  >
                    <span>Move Up</span>
                    <span
                      className="thread-context-menu__shortcut"
                      aria-hidden="true"
                    >
                      {"⌘⇧↑"}
                    </span>
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    aria-keyshortcuts="Meta+Shift+ArrowDown"
                    disabled={!contextMenuCanMoveDown}
                    onClick={() =>
                      moveThreadFromContextMenu(contextMenu.thread, "down")
                    }
                  >
                    <span>Move Down</span>
                    <span
                      className="thread-context-menu__shortcut"
                      aria-hidden="true"
                    >
                      {"⌘⇧↓"}
                    </span>
                  </button>
                </>
              ) : null}
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
          {(contextMenu.thread.messagingBindings ?? []).length > 0
            && props.onUnbindMessagingBinding ? (
            <>
              <div className="thread-context-menu__section">
                {(contextMenu.thread.messagingBindings ?? []).map((binding) => (
                  <button
                    key={binding.bindingId}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      const target = contextMenu.thread;
                      setContextMenu(undefined);
                      void props.onUnbindMessagingBinding!(target, binding);
                    }}
                  >
                    Unbind from {formatPlatformLabel(binding.platform)}
                    {binding.conversationTitle
                      ? ` (${binding.conversationTitle})`
                      : ""}
                  </button>
                ))}
              </div>
              <div className="thread-context-menu__separator" role="separator" />
            </>
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

      {directoryContextMenu ? (
        <div
          ref={directoryContextMenuRef}
          className="thread-context-menu"
          role="menu"
          style={{
            left:
              directoryContextMenu.position?.x ??
              directoryContextMenu.requestedPosition.x,
            top:
              directoryContextMenu.position?.y ??
              directoryContextMenu.requestedPosition.y,
            visibility: directoryContextMenu.position ? undefined : "hidden",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="thread-context-menu__section">
            <button
              role="menuitem"
              type="button"
              onClick={() =>
                togglePinDirectoryFromContextMenu(directoryContextMenu.directory)
              }
            >
              {directoryContextMenu.directory.pinnedRank
                ? "Unpin Directory"
                : "Pin Directory"}
            </button>
            {directoryMenuShowMoveItems ? (
              <>
                <button
                  role="menuitem"
                  type="button"
                  aria-keyshortcuts="Meta+Shift+ArrowUp"
                  disabled={!directoryMenuCanMoveUp}
                  onClick={() =>
                    moveDirectoryFromContextMenu(
                      directoryContextMenu.directory,
                      "up",
                    )
                  }
                >
                  <span>Move Up</span>
                  <span
                    className="thread-context-menu__shortcut"
                    aria-hidden="true"
                  >
                    {"⌘⇧↑"}
                  </span>
                </button>
                <button
                  role="menuitem"
                  type="button"
                  aria-keyshortcuts="Meta+Shift+ArrowDown"
                  disabled={!directoryMenuCanMoveDown}
                  onClick={() =>
                    moveDirectoryFromContextMenu(
                      directoryContextMenu.directory,
                      "down",
                    )
                  }
                >
                  <span>Move Down</span>
                  <span
                    className="thread-context-menu__shortcut"
                    aria-hidden="true"
                  >
                    {"⌘⇧↓"}
                  </span>
                </button>
              </>
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

function formatProfileIdentityLabel(
  activeProfile: string,
  profile?: DesktopPwrAgentProfileSummary,
): string {
  const codexProfile = profile?.codexProfile;
  const codexName =
    codexProfile?.name || (codexProfile ? "default" : undefined);
  return codexName
    ? `profile:${activeProfile}, codex:${codexName}`
    : `profile:${activeProfile}`;
}

function formatProfileIdentityTooltip(params: {
  activeProfile: string;
  codexBackend?: BackendSummary;
  profile?: DesktopPwrAgentProfileSummary;
}): string {
  const lines = [
    `PwrAgent profile: ${params.activeProfile}`,
  ];
  const codexProfile = params.profile?.codexProfile;
  if (codexProfile) {
    lines.push(`Codex profile: ${codexProfile.name || "default"}`);
    lines.push(`Codex home: ${codexProfile.codexHome}`);
  }
  const account = params.codexBackend?.account;
  if (params.codexBackend?.available && account) {
    lines.push(`Codex account: ${account.email ?? "unknown"}`);
    if (account.planType) {
      lines.push(`Plan: ${account.planType}`);
    }
  } else if (params.codexBackend?.unavailableReason) {
    lines.push(`Codex account: unavailable (${params.codexBackend.unavailableReason})`);
  } else if (params.codexBackend) {
    lines.push("Codex account: not reported");
  }
  const limits = params.codexBackend ? selectVisibleRateLimits(params.codexBackend) : [];
  if (limits.length) {
    lines.push("Limits:");
    for (const limit of limits) {
      lines.push(formatRateLimitLine(limit));
    }
  }
  lines.push("Click to open profile menu");
  return lines.join("\n");
}

function formatPlatformLabel(platform: string): string {
  if (!platform) return platform;
  return platform.charAt(0).toUpperCase() + platform.slice(1);
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

function ProfileIdentityButton(props: {
  label: string;
  tooltipText?: string;
  onToggle: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const showTooltip = (target: HTMLButtonElement): void => {
    if (props.tooltipText) {
      tooltip.show(target, props.tooltipText);
    }
  };

  return (
    <>
      <button
        aria-label="Open PwrAgent profile menu"
        className="runtime-identity__button"
        type="button"
        onBlur={tooltip.hide}
        onClick={(event) => {
          tooltip.hide();
          props.onToggle(event);
        }}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={tooltip.hide}
      >
        <span className="runtime-identity__text">{props.label}</span>
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

function RuntimeIdentityButton(props: {
  copied: boolean;
  copyLabel?: string;
  label: string;
  value: string;
  valueKind: "branch" | "cwd";
  onCopied: (valueKind: "branch" | "cwd") => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const tooltipText = props.copied
    ? "Copied"
    : `${props.value}\nClick to copy to clipboard`;

  return (
    <>
      <button
        aria-label={`Copy ${
          props.copyLabel ?? (props.valueKind === "cwd" ? "working directory" : "branch name")
        }`}
        className="runtime-identity__button path-copy-target"
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          void copyText(props.value).then(() => props.onCopied(props.valueKind));
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        <span aria-hidden="true" className="runtime-identity__icon">
          {props.valueKind === "cwd" ? <FolderIcon size={13} /> : <BranchIcon size={13} />}
        </span>
        <span className="runtime-identity__text">{props.label}</span>
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
