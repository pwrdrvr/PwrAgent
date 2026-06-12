import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent,
} from "react";
import type {
  AppServerBackendKind,
  BackendSummary,
  DesktopPwrAgentProfileSummary,
  MessagingThreadBindingSummary,
  NavigationDirectorySummary,
  NavigationThreadSummary,
  PrSummary,
  ThreadExecutionMode,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  comparePinnedDirectories,
  comparePinnedThreads,
  isPinnedDirectory,
  isPinnedThread,
  moveDirectoryKey,
  moveThreadKey,
} from "@pwragent/shared";
import type { RuntimeIdentity } from "../../../../shared/runtime-identity";
import { copyText } from "../../lib/copy-text";
import { BranchIcon, FolderIcon, SearchIcon } from "../../icons";
import { NewThreadButton } from "../chrome/NewThreadButton";
import type {
  ArchiveThreadOptions,
  BrowseMode,
  ThreadWorkspaceMode,
} from "../../lib/useThreadNavigation";
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
  automationsActive?: boolean;
  profiles?: DesktopPwrAgentProfileSummary[];
  threadSearchActive?: boolean;
  settingsActive?: boolean;
  approvalRequestThreadKeys?: Record<string, boolean>;
  /** Identity key of the card to highlight as the open composer's source. */
  composerSourceThreadKey?: string;
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onCreateThread: () => Promise<void>;
  onCreateThreadWithoutDirectory?: () => Promise<void>;
  /** Directory the default New Thread action resolves to (flyout label). */
  newThreadDirectoryLabel?: string;
  onCreateSubthread?: (
    thread: NavigationThreadSummary,
    mode: ThreadWorkspaceMode,
  ) => Promise<void>;
  onForkThread?: (
    thread: NavigationThreadSummary,
    mode: ThreadWorkspaceMode,
  ) => Promise<void>;
  onOpenAutomations?: () => void;
  onOpenThreadSearch?: () => void;
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onOpenSettings?: () => void;
  onOpenProfile?: (profile: string) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onArchiveThread?: (
    thread: NavigationThreadSummary,
    options?: ArchiveThreadOptions,
  ) => Promise<void>;
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
  onReorderThreadPins?: (orderedThreadKeys: string[]) => Promise<void>;
  onSetThreadParent?: (
    thread: NavigationThreadSummary,
    parentThreadId?: string,
  ) => Promise<void>;
  onUpdateSubthreadOrder?: (
    parent: NavigationThreadSummary,
    threadIds: string[],
  ) => Promise<void>;
  onSetSubthreadsCollapsed?: (
    parent: NavigationThreadSummary,
    collapsed: boolean,
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
        pullRequest?: PrSummary;
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

  const canForkThread = (thread: NavigationThreadSummary): boolean =>
    props.backends.some(
      (backend) =>
        backend.kind === thread.source &&
        backend.available &&
        backend.capabilities.forkThread === true
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

  const openPullRequestContextMenu = (
    thread: NavigationThreadSummary,
    pullRequest: PrSummary,
    position: ThreadContextMenuPosition,
  ): void => {
    setRenameThread(undefined);
    setDirectoryContextMenu(undefined);
    setContextMenu({ requestedPosition: position, pullRequest, thread });
  };

  const requestRenameFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    setRenameThread(thread);
    setRenameDraft(thread.title);
    setRenameValidationError(undefined);
  };

  const archiveFromContextMenu = (
    thread: NavigationThreadSummary,
    options?: ArchiveThreadOptions,
  ): void => {
    setContextMenu(undefined);
    if (options) {
      void onArchiveThread(thread, options);
      return;
    }
    void onArchiveThread(thread);
  };

  const createSubthreadFromContextMenu = (
    thread: NavigationThreadSummary,
    mode: ThreadWorkspaceMode,
  ): void => {
    setContextMenu(undefined);
    void props.onCreateSubthread?.(thread, mode);
  };

  const forkThreadFromContextMenu = (
    thread: NavigationThreadSummary,
    mode: ThreadWorkspaceMode,
  ): void => {
    setContextMenu(undefined);
    void props.onForkThread?.(thread, mode);
  };

  const unlinkSubthreadFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    void props.onSetThreadParent?.(thread, undefined);
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
   * Pinned-thread identity keys in stable global order. Pin order is global
   * across backends (mirrors directory pinning), so a single sorted array is
   * enough to compute Move Up / Move Down adjacency for the context menu.
   */
  const pinnedThreadKeysInOrder = useMemo(
    () =>
      [...props.threads]
        .filter(isPinnedThread)
        .sort(comparePinnedThreads)
        .map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
    [props.threads],
  );

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
    const ordered = pinnedThreadKeysInOrder;
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const currentIndex = ordered.indexOf(threadKey);
    if (currentIndex === -1) return;
    const targetIndex =
      direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= ordered.length) return;
    const targetKey = ordered[targetIndex]!;
    const nextKeys = moveThreadKey(
      ordered,
      threadKey,
      targetKey,
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
    void props.onReorderThreadPins?.(nextKeys);
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
  const contextMenuChildThreadCount = contextMenu
    ? props.threads.filter(
        (thread) =>
          thread.source === contextMenu.thread.source &&
          thread.parentThreadId === contextMenu.thread.id,
      ).length
    : 0;
  const contextMenuHasChildThreads = contextMenuChildThreadCount > 0;
  const contextMenuLocalPath = contextMenu?.thread.linkedDirectories.find(
    (directory) => directory.kind === "local"
  )?.path;
  const contextMenuWorktreePath = contextMenu?.thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree"
  );
  const contextMenuWorktreeCopyPath =
    contextMenuWorktreePath?.worktreePath ?? contextMenuWorktreePath?.path;
  const contextMenuHasLocalWorkspace = Boolean(contextMenuLocalPath);
  const contextMenuHasWorktreeWorkspace = Boolean(contextMenuWorktreePath);
  const contextMenuHasWorkspace =
    contextMenuHasLocalWorkspace || contextMenuHasWorktreeWorkspace;
  const contextMenuBranchName = contextMenu?.thread.gitBranch;
  const contextMenuPullRequest = contextMenu?.pullRequest;
  const contextMenuIsSubthread = Boolean(contextMenu?.thread.parentThreadId);
  // Sub-thread / fork are available from child cards too: spawning from a child
  // re-parents the new thread to the group root (one level deep, inserted below
  // the source), so there is no orphaned-grandchild risk to gate against.
  const contextMenuCanCreateSubthread = Boolean(
    contextMenu && contextMenuHasWorkspace && props.onCreateSubthread,
  );
  const contextMenuCanFork = Boolean(
    contextMenu &&
      contextMenu.thread.source === "codex" &&
      contextMenuHasWorkspace &&
      canForkThread(contextMenu.thread) &&
      props.onForkThread,
  );
  const contextMenuCanUnlinkSubthread = Boolean(
    contextMenuIsSubthread && props.onSetThreadParent,
  );
  const contextMenuCanPin = Boolean(
    contextMenu && !contextMenuIsSubthread && props.onSetThreadPin,
  );
  /**
   * Move Up / Move Down show as menu items only when the target
   * thread is pinned (reorder only applies inside the pinned
   * section) AND the reorder IPC is wired. Each item is then
   * disabled when the thread is at the top / bottom of the global
   * pinned section. We render the items even when disabled
   * so the menu layout doesn't jump as the user walks the list.
   */
  const contextMenuShowMoveItems = Boolean(
    contextMenu?.thread.pinnedRank && props.onReorderThreadPins,
  );
  const contextMenuPinnedThreadIndex = contextMenu
    ? pinnedThreadKeysInOrder.indexOf(
        buildThreadIdentityKey(contextMenu.thread.source, contextMenu.thread.id),
      )
    : -1;
  const contextMenuPinnedThreadCount = pinnedThreadKeysInOrder.length;
  const contextMenuCanMoveUp =
    contextMenuShowMoveItems && contextMenuPinnedThreadIndex > 0;
  const contextMenuCanMoveDown =
    contextMenuShowMoveItems &&
    contextMenuPinnedThreadIndex >= 0 &&
    contextMenuPinnedThreadIndex < contextMenuPinnedThreadCount - 1;
  const contextMenuHasTopActions =
    contextMenuCanPin ||
    contextMenuCanCreateSubthread ||
    contextMenuCanFork ||
    contextMenuCanUnlinkSubthread ||
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
          <MastheadActionButton
            ariaLabel="Search threads"
            ariaPressed={props.threadSearchActive}
            className={`sidebar__icon-button${props.threadSearchActive ? " is-active" : ""}`}
            onClick={props.onOpenThreadSearch}
          >
            <SearchIcon size={16} aria-hidden />
          </MastheadActionButton>
          <MastheadActionButton
            ariaLabel="Open automations"
            ariaPressed={props.automationsActive}
            className={`sidebar__icon-button${props.automationsActive ? " is-active" : ""}`}
            onClick={props.onOpenAutomations}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>
          </MastheadActionButton>
          <MastheadActionButton
            ariaLabel="Open settings"
            ariaPressed={props.settingsActive}
            className={`sidebar__icon-button${props.settingsActive ? " is-active" : ""}`}
            onClick={props.onOpenSettings}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </MastheadActionButton>
          <NewThreadButton
            creatingThread={Boolean(props.creatingThread)}
            directoryLabel={props.newThreadDirectoryLabel}
            onCreateThread={() => props.onCreateThread()}
            onCreateThreadWithoutDirectory={props.onCreateThreadWithoutDirectory}
          />
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
              composerSourceThreadKey={props.composerSourceThreadKey}
              directories={props.directories}
              selectedItemKey={props.selectedItemKey}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.threads}
              onOpenThreadContextMenu={openThreadContextMenu}
              onOpenLaunchpad={props.onOpenLaunchpad}
              onPrefetchPullRequests={props.onPrefetchPullRequests}
              onReorderThreadPins={props.onReorderThreadPins}
              onUpdateSubthreadOrder={props.onUpdateSubthreadOrder}
              onSetSubthreadsCollapsed={props.onSetSubthreadsCollapsed}
              onSetDirectoryPin={props.onSetDirectoryPin}
              onReorderDirectoryPins={props.onReorderDirectoryPins}
              onOpenDirectoryContextMenu={
                props.onSetDirectoryPin ? openDirectoryContextMenu : undefined
              }
              onOpenPullRequestContextMenu={openPullRequestContextMenu}
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
                composerSourceThreadKey={props.composerSourceThreadKey}
                selectedThreadKey={props.selectedItemKey}
                thinkingThreadKeys={props.thinkingThreadKeys}
                threads={visibleThreads}
                onOpenThreadContextMenu={openThreadContextMenu}
                onOpenPullRequestContextMenu={openPullRequestContextMenu}
                onPrefetchPullRequests={props.onPrefetchPullRequests}
                onReorderThreadPins={props.onReorderThreadPins}
                onUpdateSubthreadOrder={props.onUpdateSubthreadOrder}
                onSetSubthreadsCollapsed={props.onSetSubthreadsCollapsed}
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
              {contextMenuCanCreateSubthread || contextMenuCanFork ? (
                <>
                  {contextMenuCanCreateSubthread ? (
                    contextMenuHasWorktreeWorkspace ? (
                      <>
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() =>
                            createSubthreadFromContextMenu(
                              contextMenu.thread,
                              "same-worktree",
                            )
                          }
                        >
                          Sub-thread in Same Worktree
                        </button>
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() =>
                            createSubthreadFromContextMenu(
                              contextMenu.thread,
                              "new-worktree",
                            )
                          }
                        >
                          Sub-thread in New Worktree
                        </button>
                      </>
                    ) : (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() =>
                          createSubthreadFromContextMenu(
                            contextMenu.thread,
                            "local",
                          )
                        }
                      >
                        Sub-thread in Local
                      </button>
                    )
                  ) : null}
                  {contextMenuCanFork ? (
                    contextMenuHasWorktreeWorkspace ? (
                      <>
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() =>
                            forkThreadFromContextMenu(
                              contextMenu.thread,
                              "same-worktree",
                            )
                          }
                        >
                          Fork into Same Worktree
                        </button>
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() =>
                            forkThreadFromContextMenu(
                              contextMenu.thread,
                              "new-worktree",
                            )
                          }
                        >
                          Fork into New Worktree
                        </button>
                      </>
                    ) : (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() =>
                          forkThreadFromContextMenu(
                            contextMenu.thread,
                            "local",
                          )
                        }
                      >
                        Fork in Local
                      </button>
                    )
                  ) : null}
                </>
              ) : null}
              {contextMenuCanUnlinkSubthread ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => unlinkSubthreadFromContextMenu(contextMenu.thread)}
                >
                  Unlink from Parent
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
              {contextMenuCanArchive && contextMenuHasChildThreads ? (
                <>
                  <button
                    aria-label={`Archive Thread Only. Ungroup ${
                      contextMenuChildThreadCount === 1
                        ? "1 sub-thread"
                        : `${contextMenuChildThreadCount} sub-threads`
                    }`}
                    className="thread-context-menu__button--stacked"
                    role="menuitem"
                    type="button"
                    onClick={() =>
                      archiveFromContextMenu(contextMenu.thread, {
                        includeSubthreads: false,
                      })
                    }
                  >
                    <span>Archive Thread Only</span>
                    <span className="thread-context-menu__item-detail">
                      Ungroup{" "}
                      {contextMenuChildThreadCount === 1
                        ? "1 sub-thread"
                        : `${contextMenuChildThreadCount} sub-threads`}
                    </span>
                  </button>
                  <button
                    aria-label={`Archive Thread and Sub-Threads. Archive ${
                      contextMenuChildThreadCount + 1
                    } threads`}
                    className="thread-context-menu__button--stacked"
                    role="menuitem"
                    type="button"
                    onClick={() =>
                      archiveFromContextMenu(contextMenu.thread, {
                        includeSubthreads: true,
                      })
                    }
                  >
                    <span>Archive Thread + Sub-Threads</span>
                    <span className="thread-context-menu__item-detail">
                      Archive {contextMenuChildThreadCount + 1} threads
                    </span>
                  </button>
                </>
              ) : contextMenuCanArchive ? (
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
            {contextMenuPullRequest ? (
              <button
                role="menuitem"
                type="button"
                onClick={() => copyFromContextMenu(contextMenuPullRequest.url)}
              >
                Copy Pull Request URL
              </button>
            ) : null}
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

function MastheadActionButton(props: {
  ariaLabel: string;
  ariaPressed?: boolean;
  children: ReactNode;
  className: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <>
      <button
        aria-label={props.ariaLabel}
        aria-pressed={props.ariaPressed}
        className={props.className}
        disabled={props.disabled}
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          props.onClick?.();
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, props.ariaLabel)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, props.ariaLabel)}
        onMouseLeave={tooltip.hide}
      >
        {props.children}
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
