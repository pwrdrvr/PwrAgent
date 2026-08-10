import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
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
  buildThreadUrl,
  comparePinnedDirectories,
  comparePinnedThreads,
  isPinnedDirectory,
  isPinnedThread,
  moveDirectoryKey,
  moveThreadKey,
  resolveThreadParentKey,
} from "@pwragent/shared";
import {
  readRendererFederationLabel,
  readRendererFederationTarget,
} from "../../lib/federation-window";
import type { RuntimeIdentity } from "../../../../shared/runtime-identity";
import { copyText } from "../../lib/copy-text";
import {
  BranchIcon,
  CalendarPlusIcon,
  DraftIcon,
  FolderIcon,
  HistoryIcon,
  SearchIcon,
  type IconProps,
} from "../../icons";
import { FederationRemoteBadge } from "../chrome/FederationRemoteBadge";
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
import type { ThreadQueuedMessageState } from "../../lib/useThreadQueuedMessageIndicators";
import { selectThreadsWithDrafts } from "../../lib/useThreadDraftIndicators";
import { formatPrimaryAccel } from "../../lib/keyboard-accel";
import {
  DetachPullRequestWarning,
  shouldShowDetachPullRequestWarning,
} from "../pr-status/DetachPullRequestWarning";
import { SidebarSearchPopup } from "./SidebarSearchPopup";
import {
  formatRateLimitLine,
  selectVisibleRateLimits,
} from "../../lib/backend-status-format";
import { DirectoriesList } from "./DirectoriesList";
import { RecentsList } from "./RecentsList";
import {
  formatActiveThreadCount,
  formatReviewThreadCount,
  isThreadActive,
  isThreadNeedingAttention,
} from "./ThreadRowStatus";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";

type ThreadContextMenuPosition = {
  x: number;
  y: number;
  anchorTop?: number;
};

type SidebarProps = {
  backends: BackendSummary[];
  browseMode: BrowseMode;
  createThreadError?: string;
  pickDirectoryError?: string;
  directories: NavigationDirectorySummary[];
  error?: string;
  inboxThreads?: NavigationThreadSummary[];
  recentThreads?: NavigationThreadSummary[];
  /** A snapshot exists even if its latest refresh failed. */
  loaded?: boolean;
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
  /** Thread keys with a live integrated terminal in the main process. */
  terminalThreadKeys?: Record<string, boolean>;
  inputRequestThreadKeys?: Record<string, boolean>;
  /**
   * Identity key → pending outbound-message state, for the
   * "Scheduled"/"Queued" thread-row chip. Absent key = no pending send.
   */
  queuedMessageThreadKeys?: Record<string, ThreadQueuedMessageState>;
  /**
   * Threads holding unsent composer text. Window-local: a draft never
   * leaves the machine it was typed on (see useThreadDraftIndicators).
   */
  draftThreadKeys?: Record<string, boolean>;
  /** Identity key of the card to highlight as the open composer's source. */
  composerSourceThreadKey?: string;
  /** Incremented when the thread title asks the active lens to reveal its row. */
  revealSelectedThreadRequest?: number;
  onRevealSelectedThreadComplete?: (request: number) => void;
  selectedItemKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  threads: NavigationThreadSummary[];
  onBrowseModeChange: (browseMode: BrowseMode) => void;
  onCreateThread: () => Promise<void>;
  onCreateThreadWithoutDirectory?: () => Promise<void>;
  onAddProjectDirectory?: () => Promise<void>;
  addingProjectDirectory?: boolean;
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
  /** Quick-jump popup (⌘F while the sidebar is focused), owned by App. */
  threadJumpOpen?: boolean;
  onThreadJumpOpenChange?: (open: boolean) => void;
  onJumpToThread?: (thread: NavigationThreadSummary) => void;
  /** ⌘K result owned by another instance: pin it locally, then open it. */
  onJumpToRemoteThread?: (thread: NavigationThreadSummary) => void;
  /**
   * Delete the viewer-side pin for a remote thread row. Local-only: must
   * work while the owning instance is unreachable.
   */
  onRemoveRemoteThreadPin?: (
    thread: NavigationThreadSummary,
  ) => Promise<void> | void;
  onOpenLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  onOpenSettings?: () => void;
  onOpenProfile?: (profile: string) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onMarkThreadsSeen?: (threads: NavigationThreadSummary[]) => Promise<void>;
  onMarkThreadUnread?: (thread: NavigationThreadSummary) => Promise<void>;
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
  onSetDirectoryThreadsCollapsed?: (
    directory: NavigationDirectorySummary,
    collapsed: boolean,
  ) => Promise<void>;
  /**
   * Remove an empty directory (no linked threads) from the Directories list.
   * Offered in the directory context menu only when the directory has no
   * threads; deletes the registered launchpad overlay row that keeps the empty
   * row visible.
   */
  onRemoveDirectory?: (directory: NavigationDirectorySummary) => void;
  /**
   * Called by thread rows when the user hovers a non-merged PR chip
   * (or the row itself, depending on chip strategy). Used to prefetch
   * fresh PR status before they click in.
   */
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  onPrefetchGitWorkingState?: (thread: NavigationThreadSummary) => void;
  onDetachPullRequest?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
  ) => Promise<void>;
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

/**
 * Lens order. Attention leads: it is the only lens that reports state rather
 * than just ordering threads, so it is the first thing read on the row and
 * the one worth glancing at without opening.
 */
const BROWSE_MODES = [
  "attention",
  "drafts",
  "inbox",
  "recents",
  "directories",
] as const satisfies readonly BrowseMode[];

// Each lens tab renders as an icon only, so these labels are no longer visible
// text — they are the tab's accessible name and the first line of its tooltip.
const browseModeLabels = {
  attention: "Attention",
  drafts: "Drafts",
  inbox: "Updated",
  recents: "Created",
  directories: "Directories",
} satisfies Record<BrowseMode, string>;

// Attention is absent: it renders its two live indicators instead of an icon.
const browseModeIcons = {
  drafts: DraftIcon,
  inbox: HistoryIcon,
  recents: CalendarPlusIcon,
  directories: FolderIcon,
} satisfies Record<Exclude<BrowseMode, "attention">, (props: IconProps) => ReactElement>;

// Nothing on the tab spells out what the lens shows now that the labels are
// gone, so the viewport tooltip carries both the name and the explanation.
const browseModeTooltips = {
  attention: "Attention — threads in progress or waiting to be reviewed",
  drafts: "Drafts — threads with a reply you started and never sent",
  inbox: "Updated — all threads, most recently updated first",
  recents: "Created — all threads, newest created first",
  directories: "Directories — threads grouped by linked Git directory",
} satisfies Record<BrowseMode, string>;

function formatThreadCount(count: number): string {
  return `${count} ${count === 1 ? "Thread" : "Threads"}`;
}

function formatDirectoryCount(count: number): string {
  return `${count} ${count === 1 ? "Directory" : "Directories"}`;
}

function uniqueContextMenuValues(
  values: Array<string | undefined>,
): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function Sidebar(props: SidebarProps) {
  const federationLabel = readRendererFederationLabel();
  const federationTarget = readRendererFederationTarget();
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const directoryContextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const handledRevealRequestRef = useRef(0);
  const selectionAnchorKeyRef = useRef<string | undefined>(
    props.selectedItemKey,
  );
  const directorySelectionAnchorKeyRef = useRef<string | undefined>(undefined);
  const previousSelectedItemKeyRef = useRef<string | undefined>(
    props.selectedItemKey,
  );
  const [directoryRevealRequest, setDirectoryRevealRequest] = useState(0);
  const [selectedThreadKeys, setSelectedThreadKeys] = useState<Set<string>>(
    () =>
      props.selectedItemKey
        ? new Set([props.selectedItemKey])
        : new Set<string>(),
  );
  const [selectedDirectoryKeys, setSelectedDirectoryKeys] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [contextMenu, setContextMenu] = useState<
    | {
        requestedPosition: ThreadContextMenuPosition;
        position?: { x: number; y: number };
        pullRequest?: PrSummary;
        thread: NavigationThreadSummary;
        threads: NavigationThreadSummary[];
      }
    | undefined
  >();
  /**
   * Directory context menu — parallel to `contextMenu` (the thread
   * context menu) but carries directory-specific actions such as
   * marking contained threads read and pinning. Kept as its own state
   * instead of polymorphizing the thread menu because the thread menu has many
   * thread-shaped actions (Rename / Archive / Copy / Unbind) that
   * don't make sense on directories. Plan 2026-05-09-002 Unit M.
   */
  const [directoryContextMenu, setDirectoryContextMenu] = useState<
    | {
        requestedPosition: ThreadContextMenuPosition;
        position?: { x: number; y: number };
        directory: NavigationDirectorySummary;
        directories: NavigationDirectorySummary[];
      }
    | undefined
  >();
  const [pendingDetachPullRequest, setPendingDetachPullRequest] = useState<
    | {
        thread: NavigationThreadSummary;
        pr: PrSummary;
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
  const updatedOrderThreads = props.inboxThreads ?? props.threads;
  /**
   * The Attention lens: everything with a live turn or waiting to be
   * reviewed, in most-recently-updated order (the same order the Updated lens
   * uses) so the freshest work sits at the top of the queue.
   */
  const attentionThreads = useMemo(
    () =>
      updatedOrderThreads.filter((thread) =>
        isThreadNeedingAttention(thread, props.thinkingThreadKeys),
      ),
    [props.thinkingThreadKeys, updatedOrderThreads],
  );
  /**
   * The Drafts lens: everything holding unsent composer text, in the same
   * most-recently-updated order Attention uses. Filtered from the very map the
   * rows render their "Draft" chip from, so the lens and the chips agree by
   * construction.
   */
  const draftThreads = useMemo(
    () => selectThreadsWithDrafts(updatedOrderThreads, props.draftThreadKeys),
    [props.draftThreadKeys, updatedOrderThreads],
  );
  const visibleThreads =
    props.browseMode === "attention"
      ? attentionThreads
      : props.browseMode === "drafts"
        ? draftThreads
        : props.browseMode === "recents"
          ? props.recentThreads ?? props.threads
          : updatedOrderThreads;
  /**
   * The two numbers on the Attention tab. Counted over the very rows the lens
   * renders, not over `props.threads`, so the tab and the list cannot report
   * different populations — `active + review` is the queue's length by
   * construction. A live turn wins over "to review" so one thread is never
   * counted twice; membership already guarantees a row that is not active is
   * awaiting review, which is the same split the directory headers use.
   */
  const attentionCounts = useMemo(() => {
    let active = 0;
    let review = 0;
    for (const thread of attentionThreads) {
      if (isThreadActive(thread, props.thinkingThreadKeys)) {
        active += 1;
      } else {
        review += 1;
      }
    }
    return { active, review };
  }, [attentionThreads, props.thinkingThreadKeys]);
  const revealSelectedThreadRequest = props.revealSelectedThreadRequest;
  const selectedItemKey = props.selectedItemKey;
  const navigationThreads = props.threads;
  const navigationThreadByKey = useMemo(
    () => new Map(
      navigationThreads.map((thread) => [
        buildThreadIdentityKey(thread.source, thread.id),
        thread,
      ]),
    ),
    [navigationThreads],
  );
  const setSubthreadsCollapsed = props.onSetSubthreadsCollapsed;
  const browseMode = props.browseMode;

  // A direct navigation change (history, search, a thread link, etc.) starts a
  // fresh selection. Modified clicks deliberately do not navigate, so they can
  // build a batch without making the detail pane jump around. Keep this in a
  // layout effect so a launchpad cannot paint once with the previous thread's
  // local batch-selection highlight still visible.
  useLayoutEffect(() => {
    if (selectedItemKey === previousSelectedItemKeyRef.current) {
      return;
    }

    previousSelectedItemKeyRef.current = selectedItemKey;
    selectionAnchorKeyRef.current = selectedItemKey;
    directorySelectionAnchorKeyRef.current = undefined;
    setSelectedThreadKeys(
      selectedItemKey ? new Set([selectedItemKey]) : new Set<string>(),
    );
    setSelectedDirectoryKeys((current) =>
      current.size === 0 ? current : new Set<string>(),
    );
  }, [selectedItemKey]);

  // Archive/refresh reconciliation can remove selected rows while the sidebar
  // stays mounted. Keep the selection and its range anchor pointed only at
  // threads still present in the navigation snapshot.
  useEffect(() => {
    const availableThreadKeys = new Set(
      navigationThreads.map((thread) =>
        buildThreadIdentityKey(thread.source, thread.id),
      ),
    );
    if (!availableThreadKeys.has(selectionAnchorKeyRef.current ?? "")) {
      selectionAnchorKeyRef.current = undefined;
    }
    setSelectedThreadKeys((current) => {
      const next = new Set(
        [...current].filter((threadKey) => availableThreadKeys.has(threadKey)),
      );
      return next.size === current.size ? current : next;
    });
  }, [navigationThreads]);

  // Directory refreshes can remove summary rows while the Directories lens
  // remains mounted. Keep the separate directory selection scoped to rows that
  // still exist, rather than letting a later context-menu action reach a stale
  // project key.
  useEffect(() => {
    const availableDirectoryKeys = new Set(
      props.directories.map((directory) => directory.key),
    );
    if (
      !availableDirectoryKeys.has(directorySelectionAnchorKeyRef.current ?? "")
    ) {
      directorySelectionAnchorKeyRef.current = undefined;
    }
    setSelectedDirectoryKeys((current) => {
      const next = new Set(
        [...current].filter((directoryKey) =>
          availableDirectoryKeys.has(directoryKey),
        ),
      );
      return next.size === current.size ? current : next;
    });
  }, [props.directories]);

  // Directory selection is a local batch operation, not navigation state. Do
  // not carry its highlighted rows into a different lens where they are no
  // longer actionable or visible.
  useEffect(() => {
    if (browseMode === "directories") {
      return;
    }
    directorySelectionAnchorKeyRef.current = undefined;
    setSelectedDirectoryKeys((current) =>
      current.size === 0 ? current : new Set<string>(),
    );
  }, [browseMode]);

  const selectThreadFromList = (
    thread: NavigationThreadSummary,
    event: ReactMouseEvent<HTMLButtonElement>,
    selectionOrder: string[],
  ): void => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);

    if (!event.metaKey && !event.shiftKey) {
      selectionAnchorKeyRef.current = threadKey;
      setSelectedThreadKeys(new Set([threadKey]));
      props.onSelectThread(thread);
      return;
    }

    if (event.shiftKey) {
      const anchorKey = selectionAnchorKeyRef.current;
      const anchorIndex = anchorKey ? selectionOrder.indexOf(anchorKey) : -1;
      const targetIndex = selectionOrder.indexOf(threadKey);
      if (anchorIndex < 0 || targetIndex < 0) {
        selectionAnchorKeyRef.current = threadKey;
        setSelectedThreadKeys((current) => {
          const next = event.metaKey ? new Set(current) : new Set<string>();
          next.add(threadKey);
          return next;
        });
        return;
      }

      const rangeStart = Math.min(anchorIndex, targetIndex);
      const rangeEnd = Math.max(anchorIndex, targetIndex);
      const range = selectionOrder.slice(rangeStart, rangeEnd + 1);
      setSelectedThreadKeys((current) => {
        const next = event.metaKey ? new Set(current) : new Set<string>();
        for (const key of range) {
          next.add(key);
        }
        return next;
      });
      return;
    }

    selectionAnchorKeyRef.current = threadKey;
    setSelectedThreadKeys((current) => {
      const next = new Set(current);
      if (next.has(threadKey)) {
        next.delete(threadKey);
      } else {
        next.add(threadKey);
      }
      return next;
    });
  };

  const selectDirectoryFromList = (
    directory: NavigationDirectorySummary,
    event: ReactMouseEvent<HTMLButtonElement>,
    selectionOrder: string[],
  ): void => {
    const directoryKey = directory.key;

    if (!event.metaKey && !event.shiftKey) {
      directorySelectionAnchorKeyRef.current = directoryKey;
      setSelectedDirectoryKeys(new Set([directoryKey]));
      return;
    }

    if (event.shiftKey) {
      const anchorKey = directorySelectionAnchorKeyRef.current;
      const anchorIndex = anchorKey ? selectionOrder.indexOf(anchorKey) : -1;
      const targetIndex = selectionOrder.indexOf(directoryKey);
      if (anchorIndex < 0 || targetIndex < 0) {
        directorySelectionAnchorKeyRef.current = directoryKey;
        setSelectedDirectoryKeys((current) => {
          const next = event.metaKey ? new Set(current) : new Set<string>();
          next.add(directoryKey);
          return next;
        });
        return;
      }

      const rangeStart = Math.min(anchorIndex, targetIndex);
      const rangeEnd = Math.max(anchorIndex, targetIndex);
      const range = selectionOrder.slice(rangeStart, rangeEnd + 1);
      setSelectedDirectoryKeys((current) => {
        const next = event.metaKey ? new Set(current) : new Set<string>();
        for (const key of range) {
          next.add(key);
        }
        return next;
      });
      return;
    }

    directorySelectionAnchorKeyRef.current = directoryKey;
    setSelectedDirectoryKeys((current) => {
      const next = new Set(current);
      if (next.has(directoryKey)) {
        next.delete(directoryKey);
      } else {
        next.add(directoryKey);
      }
      return next;
    });
  };

  useEffect(() => {
    const request = revealSelectedThreadRequest ?? 0;
    if (request <= handledRevealRequestRef.current || !selectedItemKey) {
      return;
    }

    const selectedThread = navigationThreadByKey.get(selectedItemKey);
    if (!selectedThread) {
      return;
    }
    handledRevealRequestRef.current = request;
    if (browseMode === "directories") {
      setDirectoryRevealRequest(request);
    }

    // Child rows are shared by every thread lens. Open each collapsed parent
    // in the selected thread's ancestry here, while DirectoriesList handles
    // its additional directory-only disclosures below.
    const visited = new Set<string>();
    let current = selectedThread;
    while (current.parentThreadId) {
      const parentKey = resolveThreadParentKey(current, navigationThreadByKey);
      if (!parentKey) {
        break;
      }
      if (visited.has(parentKey)) {
        break;
      }
      visited.add(parentKey);
      const parent = navigationThreadByKey.get(parentKey);
      if (!parent) {
        break;
      }
      if (parent.subthreadsCollapsed === true) {
        void setSubthreadsCollapsed?.(parent, false);
      }
      current = parent;
    }
  }, [
    browseMode,
    navigationThreadByKey,
    revealSelectedThreadRequest,
    selectedItemKey,
    setSubthreadsCollapsed,
  ]);

  useEffect(() => {
    // DirectoriesList unmounts when another lens is active. Clear its event
    // nonce on the way out so remounting the lens later cannot replay a title
    // click that was already handled in an earlier view.
    if (browseMode !== "directories" && directoryRevealRequest !== 0) {
      setDirectoryRevealRequest(0);
    }
  }, [browseMode, directoryRevealRequest]);

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
    window.addEventListener("contextmenu", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu, true);
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
    window.addEventListener("contextmenu", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu, true);
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
    window.addEventListener("contextmenu", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu, true);
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

  const resolveContextMenuThreads = (
    thread: NavigationThreadSummary,
  ): NavigationThreadSummary[] => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    if (!selectedThreadKeys.has(threadKey)) {
      selectionAnchorKeyRef.current = threadKey;
      setSelectedThreadKeys(new Set([threadKey]));
      return [thread];
    }

    const selectedThreads = props.threads.filter((candidate) =>
      selectedThreadKeys.has(
        buildThreadIdentityKey(candidate.source, candidate.id),
      ),
    );

    return selectedThreads.length > 0 ? selectedThreads : [thread];
  };

  const resolveDirectoryContextMenuDirectories = (
    directory: NavigationDirectorySummary,
  ): NavigationDirectorySummary[] => {
    if (!selectedDirectoryKeys.has(directory.key)) {
      directorySelectionAnchorKeyRef.current = directory.key;
      setSelectedDirectoryKeys(new Set([directory.key]));
      return [directory];
    }

    const selectedDirectories = props.directories.filter((candidate) =>
      selectedDirectoryKeys.has(candidate.key),
    );

    return selectedDirectories.length > 0 ? selectedDirectories : [directory];
  };

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
    setContextMenu({
      requestedPosition: position,
      thread,
      threads: resolveContextMenuThreads(thread),
    });
  };

  const openPullRequestContextMenu = (
    thread: NavigationThreadSummary,
    pullRequest: PrSummary,
    position: ThreadContextMenuPosition,
  ): void => {
    setRenameThread(undefined);
    setDirectoryContextMenu(undefined);
    setContextMenu({
      requestedPosition: position,
      pullRequest,
      thread,
      threads: [thread],
    });
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

  const markUnreadFromContextMenu = (thread: NavigationThreadSummary): void => {
    setContextMenu(undefined);
    void props.onMarkThreadUnread?.(thread);
  };

  const removeRemotePinFromContextMenu = (
    thread: NavigationThreadSummary,
  ): void => {
    setContextMenu(undefined);
    // Viewer-side delete only: works while the owner is unreachable and
    // never archives the owner's thread.
    void props.onRemoveRemoteThreadPin?.(thread);
  };

  const openDirectoryContextMenu = (
    directory: NavigationDirectorySummary,
    position: ThreadContextMenuPosition,
  ): void => {
    setContextMenu(undefined);
    setRenameThread(undefined);
    setDirectoryContextMenu({
      requestedPosition: position,
      directory,
      directories: resolveDirectoryContextMenuDirectories(directory),
    });
  };

  const togglePinDirectoryFromContextMenu = (
    directory: NavigationDirectorySummary,
  ): void => {
    setDirectoryContextMenu(undefined);
    void props.onSetDirectoryPin?.(directory, !directory.pinnedRank);
  };

  const removeDirectoryFromContextMenu = (
    directory: NavigationDirectorySummary,
  ): void => {
    setDirectoryContextMenu(undefined);
    props.onRemoveDirectory?.(directory);
  };

  const markSelectedDirectoryThreadsRead = (): void => {
    if (!directoryContextMenu) {
      return;
    }

    const directoryThreadKeys = new Set(
      directoryContextMenu.directories.flatMap(
        (directory) => directory.threadKeys,
      ),
    );
    const unreadThreads = props.threads.filter(
      (thread) =>
        directoryThreadKeys.has(
          buildThreadIdentityKey(thread.source, thread.id),
        ) && thread.inbox.inInbox,
    );
    setDirectoryContextMenu(undefined);
    void props.onMarkThreadsSeen?.(unreadThreads);
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

  const archiveThreadsFromContextMenu = (
    threads: NavigationThreadSummary[],
  ): void => {
    setContextMenu(undefined);
    void Promise.all(threads.map((thread) => onArchiveThread(thread)));
  };

  const unlinkThreadsFromContextMenu = (
    threads: NavigationThreadSummary[],
  ): void => {
    setContextMenu(undefined);
    void Promise.all(
      threads.map((thread) => props.onSetThreadParent?.(thread, undefined)),
    );
  };

  const pinThreadsFromContextMenu = (
    threads: NavigationThreadSummary[],
  ): void => {
    setContextMenu(undefined);
    const threadKeys = threads.map((thread) =>
      buildThreadIdentityKey(thread.source, thread.id),
    );
    if (props.onReorderThreadPins) {
      const nextKeys = [
        ...pinnedThreadKeysInOrder,
        ...threadKeys.filter((threadKey) => !pinnedThreadKeysInOrder.includes(threadKey)),
      ];
      void props.onReorderThreadPins(nextKeys);
      return;
    }

    void Promise.all(
      threads.map((thread) => props.onSetThreadPin?.(thread, true)),
    );
  };

  const unpinThreadsFromContextMenu = (
    threads: NavigationThreadSummary[],
  ): void => {
    setContextMenu(undefined);
    void Promise.all(
      threads.map((thread) => props.onSetThreadPin?.(thread, false)),
    );
  };

  const copyFromContextMenu = (value: string): void => {
    setContextMenu(undefined);
    void copyText(value);
  };

  const detachPullRequest = (
    thread: NavigationThreadSummary,
    pr: PrSummary,
  ): void => {
    if (!props.onDetachPullRequest) {
      return;
    }
    setContextMenu(undefined);
    if (shouldShowDetachPullRequestWarning()) {
      setPendingDetachPullRequest({ thread, pr });
      return;
    }
    void props.onDetachPullRequest(thread, pr);
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

  const contextMenuThreads = contextMenu?.threads ?? [];
  const contextMenuIsBulk = contextMenuThreads.length > 1;
  // A remote-owned row pinned into the main window's list: local overlay
  // actions (pin, archive, rename, sub-thread/fork) don't apply — the only
  // management action is removing the viewer-side pin. Federation windows
  // keep their existing behavior (every row there is remote).
  const contextMenuIsMainWindowRemoteRow = Boolean(
    contextMenu &&
      !contextMenuIsBulk &&
      contextMenu.thread.federation &&
      !federationTarget,
  );
  const contextMenuCanRemoveRemotePin = Boolean(
    contextMenuIsMainWindowRemoteRow && props.onRemoveRemoteThreadPin,
  );
  const contextMenuCanRename =
    contextMenu && !contextMenuIsBulk && !contextMenuIsMainWindowRemoteRow
      ? canRenameThread(contextMenu.thread)
      : false;
  const contextMenuCanArchive =
    contextMenu && !contextMenuIsBulk && !contextMenuIsMainWindowRemoteRow
      ? canArchiveThread(contextMenu.thread)
      : false;
  const contextMenuCanMarkUnread = Boolean(
    contextMenu &&
      !contextMenuIsBulk &&
      !contextMenuIsMainWindowRemoteRow &&
      !contextMenu.thread.inbox.inInbox &&
      contextMenu.thread.updatedAt !== undefined &&
      props.onMarkThreadUnread,
  );
  const contextMenuChildThreadCount = contextMenu && !contextMenuIsBulk
    ? props.threads.filter(
        (thread) =>
          resolveThreadParentKey(thread, navigationThreadByKey)
          === buildThreadIdentityKey(
            contextMenu.thread.source,
            contextMenu.thread.id,
          ),
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
  const contextMenuIsSubthread = Boolean(
    !contextMenuIsBulk && contextMenu?.thread.parentThreadId,
  );
  // Sub-thread / fork are available from child cards too: spawning from a child
  // re-parents the new thread to the group root (one level deep, inserted below
  // the source), so there is no orphaned-grandchild risk to gate against.
  const contextMenuCanCreateSubthread = Boolean(
    contextMenu &&
      !contextMenuIsBulk &&
      !contextMenuIsMainWindowRemoteRow &&
      contextMenuHasWorkspace &&
      props.onCreateSubthread,
  );
  const contextMenuCanFork = Boolean(
    contextMenu &&
      !contextMenuIsBulk &&
      !contextMenuIsMainWindowRemoteRow &&
      contextMenu.thread.source === "codex" &&
      contextMenuHasWorkspace &&
      canForkThread(contextMenu.thread) &&
      props.onForkThread,
  );
  const contextMenuCanUnlinkSubthread = Boolean(
    contextMenuIsSubthread && props.onSetThreadParent,
  );
  // Remote rows CAN pin here: the rank is viewer-owned (stored on the
  // remote_thread_pins row), so the owner's list never learns about it.
  const contextMenuCanPin = Boolean(
    contextMenu &&
      !contextMenuIsBulk &&
      !contextMenuIsSubthread &&
      props.onSetThreadPin,
  );
  /**
   * Move Up / Move Down show as menu items only when the target
   * thread is pinned (reorder only applies inside the pinned
   * section), the reorder IPC is wired, AND the active lens actually
   * renders a pinned section. Updated and Created are pure sort
   * orders, so a reorder there would move a thread within a list whose
   * order is invisible — the row would not budge and the menu's
   * ⌘⇧↑/↓ hint would advertise a shortcut those rows don't carry.
   * Each item is then disabled when the thread is at the top / bottom
   * of the global pinned section. We render the items even when
   * disabled so the menu layout doesn't jump as the user walks the
   * list.
   */
  const contextMenuShowMoveItems = Boolean(
    !contextMenuIsBulk &&
      browseMode === "directories" &&
      contextMenu?.thread.pinnedRank &&
      props.onReorderThreadPins,
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
  const contextMenuHasPinAction = contextMenuCanPin;
  const contextMenuHasCreationActions =
    contextMenuCanCreateSubthread || contextMenuCanFork;
  const contextMenuHasManagementActions =
    contextMenuCanUnlinkSubthread ||
    contextMenuShowMoveItems ||
    contextMenuCanRename ||
    contextMenuCanMarkUnread ||
    contextMenuCanArchive;
  const contextMenuHasTopActions =
    contextMenuHasPinAction ||
    contextMenuHasCreationActions ||
    contextMenuHasManagementActions ||
    contextMenuCanRemoveRemotePin;
  const contextMenuHasBindings = Boolean(
    !contextMenuIsBulk &&
      contextMenu &&
      (contextMenu.thread.messagingBindings ?? []).length > 0 &&
      props.onUnbindMessagingBinding,
  );

  const bulkPinnableThreads = contextMenuThreads.filter(
    (thread) => !thread.parentThreadId,
  );
  const bulkPinnedThreads = bulkPinnableThreads.filter(isPinnedThread);
  const bulkUnpinnedThreads = bulkPinnableThreads.filter(
    (thread) => !isPinnedThread(thread),
  );
  const bulkCanPin = Boolean(
    props.onReorderThreadPins || props.onSetThreadPin,
  );
  const bulkUnlinkableThreads = contextMenuThreads.filter(
    (thread) => Boolean(thread.parentThreadId),
  );
  const bulkArchivableThreads = contextMenuThreads.filter(canArchiveThread);
  const bulkHasPinActions =
    bulkCanPin &&
    (bulkPinnedThreads.length > 0 || bulkUnpinnedThreads.length > 0);
  const bulkHasManagementActions = Boolean(
    (bulkUnlinkableThreads.length > 0 && props.onSetThreadParent) ||
      bulkArchivableThreads.length > 0,
  );
  const bulkThreadLinks = uniqueContextMenuValues(
    contextMenuThreads.map((thread) =>
      buildThreadUrl({
        backend: thread.source,
        threadId: thread.id,
      }),
    ),
  );
  const bulkThreadIds = uniqueContextMenuValues(
    contextMenuThreads.map((thread) => thread.id),
  );
  const bulkThreadPaths = uniqueContextMenuValues(
    contextMenuThreads.flatMap((thread) =>
      thread.linkedDirectories.map(
        (directory) => directory.worktreePath ?? directory.path,
      ),
    ),
  );
  const bulkBranchNames = uniqueContextMenuValues(
    contextMenuThreads.map((thread) => thread.gitBranch),
  );

  const directoryContextMenuDirectories =
    directoryContextMenu?.directories ?? [];
  const directoryContextMenuIsBulk =
    directoryContextMenuDirectories.length > 1;
  const directoryMenuThreadKeys = new Set(
    directoryContextMenuDirectories.flatMap(
      (directory) => directory.threadKeys,
    ),
  );
  const directoryMenuUnreadThreads = props.threads.filter(
    (thread) =>
      directoryMenuThreadKeys.has(
        buildThreadIdentityKey(thread.source, thread.id),
      ) && thread.inbox.inInbox,
  );
  const directoryMenuCanMarkRead = Boolean(
    props.onMarkThreadsSeen && directoryMenuUnreadThreads.length > 0,
  );
  const directoryMenuCanPin = Boolean(
    !directoryContextMenuIsBulk
      && directoryContextMenu
      && props.onSetDirectoryPin,
  );
  const directoryMenuCanRemove = Boolean(
    !directoryContextMenuIsBulk
      && props.onRemoveDirectory
      && directoryContextMenu?.directory.kind === "directory"
      && directoryContextMenu.directory.threadKeys.length === 0,
  );

  // Same shape as the thread context menu's "Move" items, applied
  // to the directory context menu. Directory pinning is global so
  // a single sorted array drives both adjacency checks.
  const directoryMenuShowMoveItems = Boolean(
    !directoryContextMenuIsBulk
      && directoryContextMenu?.directory.pinnedRank
      && props.onReorderDirectoryPins,
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
  const directoryMenuHasPinActions =
    directoryMenuCanPin || directoryMenuShowMoveItems;

  return (
    <aside className="sidebar" aria-label="Threads">
      {props.threadJumpOpen ? (
        <SidebarSearchPopup
          threads={props.threads}
          onJumpToThread={props.onJumpToThread ?? props.onSelectThread}
          onJumpToRemoteThread={props.onJumpToRemoteThread}
          onClose={() => props.onThreadJumpOpenChange?.(false)}
        />
      ) : null}
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
        <p className="sidebar__brand">
          Pwr<span className="sidebar__brand-accent">Agent</span>
        </p>

        <div className="sidebar__masthead-actions">
          <MastheadActionButton
            ariaLabel="Search threads"
            tooltipText={[
              `Open Search All  (${formatPrimaryAccel("F", { shift: true })})`,
              `Quick Thread List Search  (${formatPrimaryAccel("K")})`,
              `Context Search  (${formatPrimaryAccel("F")}) — Thread List in sidebar, Thread Chat elsewhere`,
            ].join("\n")}
            ariaPressed={props.threadSearchActive}
            className={`sidebar__icon-button${props.threadSearchActive ? " is-active" : ""}`}
            onClick={props.onOpenThreadSearch}
          >
            <SearchIcon size={16} aria-hidden />
          </MastheadActionButton>
          {/* Automations and Settings are LOCAL surfaces. In a remote
              federation window, showing them would open this machine's
              screens inside a window branded as another instance — hide
              both rather than mislead. */}
          {federationLabel ? null : (
          <MastheadActionButton
            ariaLabel="Open automations"
            ariaPressed={props.automationsActive}
            className={`sidebar__icon-button${props.automationsActive ? " is-active" : ""}`}
            onClick={props.onOpenAutomations}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>
          </MastheadActionButton>
          )}
          {federationLabel ? null : (
          <MastheadActionButton
            ariaLabel="Open settings"
            ariaPressed={props.settingsActive}
            // `sidebar__masthead-settings` lets the gear drop out first when the
            // rail is too narrow for the wordmark + all four actions — Settings
            // is still reachable from the app menu (⌘,), so it's the safe one to
            // shed before the (less reachable) brand wordmark.
            className={`sidebar__icon-button sidebar__masthead-settings${props.settingsActive ? " is-active" : ""}`}
            onClick={props.onOpenSettings}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </MastheadActionButton>
          )}
          <NewThreadButton
            addingProjectDirectory={props.addingProjectDirectory}
            creatingThread={Boolean(props.creatingThread)}
            directoryLabel={props.newThreadDirectoryLabel}
            onAddProjectDirectory={props.onAddProjectDirectory}
            onCreateThread={() => props.onCreateThread()}
            onCreateThreadWithoutDirectory={props.onCreateThreadWithoutDirectory}
          />
        </div>
      </header>

      {federationLabel || federationTarget ? (
        // The remote machine's identity gets the same pill treatment as
        // the local profile/runtime rows below (which are hidden in a
        // federation window) — full name visible, tooltip + copy for the
        // instance id, instead of a truncated masthead suffix.
        <div className="runtime-identity" aria-label="Remote instance">
          <FederationRemoteBadge
            className="runtime-identity__button"
            textClassName="runtime-identity__text sidebar__federation-label"
          />
        </div>
      ) : null}

      {!federationLabel && props.runtimeIdentity ? (
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

      {!federationLabel && props.activeProfile ? (
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
      ) : props.pickDirectoryError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.pickDirectoryError}</p>
      ) : props.launchpadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.launchpadError}</p>
      ) : props.archiveThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.archiveThreadError}</p>
      ) : props.renameThreadError ? (
        <p className="sidebar-error sidebar-error--masthead">{props.renameThreadError}</p>
      ) : null}

      <section className="sidebar__section sidebar__section--fill" aria-label="Thread browser">
        <div className="lens-switch" role="tablist" aria-label="Thread lenses">
          {BROWSE_MODES.map((mode) =>
            mode === "attention" ? (
              <AttentionLensTab
                key={mode}
                active={props.browseMode === mode}
                activeThreadCount={attentionCounts.active}
                reviewThreadCount={attentionCounts.review}
                onSelect={() => props.onBrowseModeChange(mode)}
              />
            ) : (
              <LensTab
                key={mode}
                mode={mode}
                active={props.browseMode === mode}
                tooltipText={browseModeTooltips[mode]}
                onSelect={() => props.onBrowseModeChange(mode)}
              />
            ),
          )}
        </div>

        <div className="sidebar__scroll-region">
          {props.loading ? (
            <p className="sidebar-empty">Loading threads…</p>
          ) : props.error && !props.loaded ? (
            <p className="sidebar-error">{props.error}</p>
          ) : props.browseMode === "directories" ? (
            <DirectoriesList
              approvalRequestThreadKeys={props.approvalRequestThreadKeys}
              terminalThreadKeys={props.terminalThreadKeys}
              inputRequestThreadKeys={props.inputRequestThreadKeys}
              queuedMessageThreadKeys={props.queuedMessageThreadKeys}
              draftThreadKeys={props.draftThreadKeys}
              composerSourceThreadKey={props.composerSourceThreadKey}
              directories={props.directories}
              revealSelectedThreadRequest={directoryRevealRequest}
              selectedItemKey={props.selectedItemKey}
              selectedDirectoryKeys={selectedDirectoryKeys}
              selectedThreadKeys={selectedThreadKeys}
              thinkingThreadKeys={props.thinkingThreadKeys}
              threads={props.threads}
              onOpenThreadContextMenu={openThreadContextMenu}
              onOpenLaunchpad={props.onOpenLaunchpad}
              onPrefetchPullRequests={props.onPrefetchPullRequests}
              onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
              onRevealSelectedThreadComplete={
                props.onRevealSelectedThreadComplete
              }
              onDetachPullRequest={detachPullRequest}
              onReorderThreadPins={props.onReorderThreadPins}
              onUpdateSubthreadOrder={props.onUpdateSubthreadOrder}
              onSetSubthreadsCollapsed={props.onSetSubthreadsCollapsed}
              onSetDirectoryPin={props.onSetDirectoryPin}
              onReorderDirectoryPins={props.onReorderDirectoryPins}
              onSetDirectoryThreadsCollapsed={
                props.onSetDirectoryThreadsCollapsed
              }
              onOpenDirectoryContextMenu={
                props.onSetDirectoryPin || props.onMarkThreadsSeen
                  ? openDirectoryContextMenu
                  : undefined
              }
              onOpenPullRequestContextMenu={openPullRequestContextMenu}
              onSelectDirectory={selectDirectoryFromList}
              onSelectThread={selectThreadFromList}
              onSetReaction={props.onSetThreadReaction}
              onSetThreadPin={props.onSetThreadPin}
              onUnbindMessagingBinding={props.onUnbindMessagingBinding}
            />
          ) : (
            visibleThreads.length === 0 ? (
              <p className="sidebar-empty">
                {props.browseMode === "attention"
                  ? "Nothing running, nothing to review."
                  : props.browseMode === "drafts"
                    ? "No unsent drafts."
                    : "No threads yet."}
              </p>
            ) : (
              <RecentsList
                approvalRequestThreadKeys={props.approvalRequestThreadKeys}
                terminalThreadKeys={props.terminalThreadKeys}
                inputRequestThreadKeys={props.inputRequestThreadKeys}
                queuedMessageThreadKeys={props.queuedMessageThreadKeys}
                draftThreadKeys={props.draftThreadKeys}
                composerSourceThreadKey={props.composerSourceThreadKey}
                revealSelectedThreadRequest={revealSelectedThreadRequest}
                selectedThreadKey={props.selectedItemKey}
                selectedThreadKeys={selectedThreadKeys}
                thinkingThreadKeys={props.thinkingThreadKeys}
                threads={visibleThreads}
                onOpenThreadContextMenu={openThreadContextMenu}
                onOpenPullRequestContextMenu={openPullRequestContextMenu}
                onPrefetchPullRequests={props.onPrefetchPullRequests}
                onPrefetchGitWorkingState={props.onPrefetchGitWorkingState}
                onRevealSelectedThreadComplete={
                  props.onRevealSelectedThreadComplete
                }
                onDetachPullRequest={detachPullRequest}
                onUpdateSubthreadOrder={props.onUpdateSubthreadOrder}
                onSetSubthreadsCollapsed={props.onSetSubthreadsCollapsed}
                onSelectThread={selectThreadFromList}
                onSetReaction={props.onSetThreadReaction}
                onSetThreadPin={props.onSetThreadPin}
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
          aria-label={
            contextMenuIsBulk
              ? `Actions for ${formatThreadCount(contextMenuThreads.length).toLowerCase()} selected`
              : undefined
          }
          style={{
            left: contextMenu.position?.x ?? contextMenu.requestedPosition.x,
            top: contextMenu.position?.y ?? contextMenu.requestedPosition.y,
            visibility: contextMenu.position ? undefined : "hidden",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenuIsBulk ? (
            <>
              {bulkHasPinActions ? (
                <div className="thread-context-menu__section">
                  {bulkPinnedThreads.length > 0 ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => unpinThreadsFromContextMenu(bulkPinnedThreads)}
                    >
                      Unpin {formatThreadCount(bulkPinnedThreads.length)}
                    </button>
                  ) : null}
                  {bulkUnpinnedThreads.length > 0 ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => pinThreadsFromContextMenu(bulkUnpinnedThreads)}
                    >
                      Pin {formatThreadCount(bulkUnpinnedThreads.length)}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {bulkHasPinActions && bulkHasManagementActions ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              {bulkHasManagementActions ? (
                <div className="thread-context-menu__section">
                  {bulkUnlinkableThreads.length > 0 && props.onSetThreadParent ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() =>
                        unlinkThreadsFromContextMenu(bulkUnlinkableThreads)
                      }
                    >
                      Unlink {formatThreadCount(bulkUnlinkableThreads.length)} from
                      Parent
                    </button>
                  ) : null}
                  {bulkArchivableThreads.length > 0 ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() =>
                        archiveThreadsFromContextMenu(bulkArchivableThreads)
                      }
                    >
                      Archive {formatThreadCount(bulkArchivableThreads.length)}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {bulkHasPinActions || bulkHasManagementActions ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              <div className="thread-context-menu__section">
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => copyFromContextMenu(bulkThreadLinks.join("\n"))}
                >
                  Copy Thread Links
                </button>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => copyFromContextMenu(bulkThreadIds.join("\n"))}
                >
                  Copy Thread IDs
                </button>
                {bulkThreadPaths.length > 0 ? (
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => copyFromContextMenu(bulkThreadPaths.join("\n"))}
                  >
                    Copy Thread Paths
                  </button>
                ) : null}
                {bulkBranchNames.length > 0 ? (
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => copyFromContextMenu(bulkBranchNames.join("\n"))}
                  >
                    Copy Branch Names
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              {contextMenuCanRemoveRemotePin ? (
                <div className="thread-context-menu__section">
                  <button
                    aria-label="Remove from My List. The thread on the owning instance is untouched."
                    className="thread-context-menu__button--stacked"
                    role="menuitem"
                    type="button"
                    onClick={() =>
                      removeRemotePinFromContextMenu(contextMenu.thread)
                    }
                  >
                    <span>Remove from My List</span>
                    <span className="thread-context-menu__item-detail">
                      Keeps the thread on{" "}
                      {contextMenu.thread.federation?.instanceLabel ??
                        "its instance"}
                    </span>
                  </button>
                </div>
              ) : null}
              {contextMenuCanRemoveRemotePin && contextMenuHasPinAction ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              {contextMenuHasPinAction ? (
                <div className="thread-context-menu__section">
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => togglePinFromContextMenu(contextMenu.thread)}
                  >
                    {contextMenu.thread.pinnedRank ? "Unpin Thread" : "Pin Thread"}
                  </button>
                </div>
              ) : null}
              {contextMenuHasPinAction &&
              (contextMenuHasCreationActions || contextMenuHasManagementActions) ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              {contextMenuHasCreationActions ? (
                <div className="thread-context-menu__section">
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
                </div>
              ) : null}
              {contextMenuHasCreationActions && contextMenuHasManagementActions ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              {contextMenuHasManagementActions ? (
                <div className="thread-context-menu__section">
                  {contextMenuCanUnlinkSubthread ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() =>
                        unlinkSubthreadFromContextMenu(contextMenu.thread)
                      }
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
                      onClick={() =>
                        requestRenameFromContextMenu(contextMenu.thread)
                      }
                    >
                      Rename Thread
                    </button>
                  ) : null}
                  {contextMenuCanMarkUnread ? (
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() =>
                        markUnreadFromContextMenu(contextMenu.thread)
                      }
                    >
                      Mark Unread
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
              {contextMenuHasTopActions && contextMenuHasBindings ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              {contextMenuHasBindings ? (
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
              ) : null}
              {contextMenuHasTopActions || contextMenuHasBindings ? (
                <div className="thread-context-menu__separator" role="separator" />
              ) : null}
              <div className="thread-context-menu__section">
                {contextMenuPullRequest ? (
                  <>
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => copyFromContextMenu(contextMenuPullRequest.url)}
                    >
                      Copy Pull Request URL
                    </button>
                    {props.onDetachPullRequest ? (
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() =>
                          detachPullRequest(contextMenu.thread, contextMenuPullRequest)
                        }
                      >
                        Detach Pull Request
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button
                  role="menuitem"
                  type="button"
                  onClick={() =>
                    copyFromContextMenu(
                      buildThreadUrl({
                        backend: contextMenu.thread.source,
                        threadId: contextMenu.thread.id,
                      }),
                    )
                  }
                >
                  Copy Thread Link
                </button>
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
            </>
          )}
        </div>
      ) : null}

      {pendingDetachPullRequest ? (
        <DetachPullRequestWarning
          pr={pendingDetachPullRequest.pr}
          onCancel={() => setPendingDetachPullRequest(undefined)}
          onConfirm={() => {
            const pending = pendingDetachPullRequest;
            setPendingDetachPullRequest(undefined);
            void props.onDetachPullRequest?.(pending.thread, pending.pr);
          }}
        />
      ) : null}

      {directoryContextMenu ? (
        <div
          ref={directoryContextMenuRef}
          className="thread-context-menu"
          role="menu"
          aria-label={
            directoryContextMenuIsBulk
              ? `Actions for ${formatDirectoryCount(
                  directoryContextMenuDirectories.length,
                ).toLowerCase()} selected`
              : undefined
          }
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
          {directoryMenuCanMarkRead ? (
            <div className="thread-context-menu__section">
              <button
                role="menuitem"
                type="button"
                onClick={markSelectedDirectoryThreadsRead}
              >
                Mark Read
              </button>
            </div>
          ) : null}
          {directoryMenuCanMarkRead && directoryMenuHasPinActions ? (
            <div className="thread-context-menu__separator" role="separator" />
          ) : null}
          {directoryMenuHasPinActions ? (
            <div className="thread-context-menu__section">
              {directoryMenuCanPin ? (
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
              ) : null}
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
          ) : null}
          {directoryMenuCanRemove
            && (directoryMenuCanMarkRead || directoryMenuHasPinActions) ? (
            <div className="thread-context-menu__separator" role="separator" />
          ) : null}
          {directoryMenuCanRemove ? (
            <div className="thread-context-menu__section">
              <button
                role="menuitem"
                type="button"
                onClick={() =>
                  removeDirectoryFromContextMenu(directoryContextMenu.directory)
                }
              >
                Remove Directory
              </button>
            </div>
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

/**
 * The Attention tab. Where the other three lenses show a static icon, this one
 * shows the two numbers it exists for: threads with a live turn, and threads
 * waiting to be reviewed. Each pairs the same indicator its thread rows use —
 * the scanner and the orange cookie.
 *
 * A zero count stays on the tab and goes grey rather than disappearing. That
 * is the point of the tab: "nothing running, nothing unread" has to be legible
 * at a glance without opening the lens, and a count that vanishes at zero
 * makes an idle tab indistinguishable from a tab that lost its data. Grey is
 * also the honest colour — the accent is a signal here, so only a nonzero
 * count earns it.
 */
function AttentionLensTab(props: {
  active: boolean;
  activeThreadCount: number;
  reviewThreadCount: number;
  onSelect: () => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const tooltipText = [
    browseModeTooltips.attention,
    `${formatActiveThreadCount(props.activeThreadCount)} · ${formatReviewThreadCount(props.reviewThreadCount)}`,
  ].join("\n");

  return (
    <>
      <button
        role="tab"
        aria-label={`${browseModeLabels.attention}, ${formatActiveThreadCount(
          props.activeThreadCount,
        )}, ${formatReviewThreadCount(props.reviewThreadCount)}`}
        aria-selected={props.active}
        className={`lens-switch__button lens-switch__button--attention${
          props.active ? " is-active" : ""
        }`}
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          props.onSelect();
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        <span
          aria-hidden="true"
          className="lens-switch__signal lens-switch__signal--active"
          data-attention-active-count={props.activeThreadCount}
          data-zero={props.activeThreadCount === 0 ? "true" : undefined}
        >
          {props.activeThreadCount === 0 ? (
            // A static stand-in, NOT a greyed-out `ThinkingScanner`. Killing
            // the sweep with CSS on a mounted scanner is a desync trap:
            // `data-zero` lives on this span, so React keeps the same scanner
            // element across the flip, its ref never re-runs, and the restarted
            // animation is never re-pinned to the shared epoch — leaving this
            // tab drifting against every other scanner on screen. Swapping the
            // element type guarantees a mount, so
            // `syncThinkingScannerAnimation` runs and the beam comes back in
            // phase. See ThinkingScanner.tsx and PR #1187.
            <span className="lens-switch__dormant-scanner" />
          ) : (
            <ThinkingScanner compact />
          )}
          <span>{props.activeThreadCount}</span>
        </span>
        <span
          aria-hidden="true"
          className="lens-switch__signal lens-switch__signal--review"
          data-attention-review-count={props.reviewThreadCount}
          data-zero={props.reviewThreadCount === 0 ? "true" : undefined}
        >
          <span className="thread-row__status-cookie" />
          <span>{props.reviewThreadCount}</span>
        </span>
      </button>
      {tooltip.tooltipNode}
    </>
  );
}

function LensTab(props: {
  mode: Exclude<BrowseMode, "attention">;
  active: boolean;
  tooltipText: string;
  onSelect: () => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const Icon = browseModeIcons[props.mode];

  return (
    <>
      <button
        // role="tab" + aria-selected is what makes the tablist a valid ARIA
        // composite. Keyboard nav is unchanged (Tab still cycles through every
        // button) since browsers don't auto-wire arrow-key navigation from role
        // alone — adding role here only changes how screen readers announce it.
        role="tab"
        // The tab renders an icon and no visible text, so aria-label is the
        // whole accessible name.
        aria-label={browseModeLabels[props.mode]}
        aria-selected={props.active}
        className={`lens-switch__button${props.active ? " is-active" : ""}`}
        type="button"
        onBlur={tooltip.hide}
        onClick={() => {
          tooltip.hide();
          props.onSelect();
        }}
        onFocus={(event) => tooltip.show(event.currentTarget, props.tooltipText)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, props.tooltipText)}
        onMouseLeave={tooltip.hide}
      >
        <Icon size={16} />
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
  /** Tooltip text; defaults to ariaLabel. Use to append a shortcut hint. */
  tooltipText?: string;
  onClick?: () => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const tooltipLabel = props.tooltipText ?? props.ariaLabel;

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
        onFocus={(event) => tooltip.show(event.currentTarget, tooltipLabel)}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, tooltipLabel)}
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
