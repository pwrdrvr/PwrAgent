import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type DragEvent,
  type PointerEvent,
} from "react";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { PinIcon, SmileyIcon } from "../../icons";
import {
  formatMessagingPlatformName,
  MESSAGING_PLATFORM_ICONS,
} from "../../lib/messaging-platform-branding";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { isNativeDragInteractionActive } from "../../lib/native-drag-interaction";
import type { ThreadQueuedMessageState } from "../../lib/useThreadQueuedMessageIndicators";
import { PrChip } from "../pr-status/PrChip";
import type { DropIndicatorPosition } from "./drag-drop";
import { ReactionPicker } from "./ReactionPicker";
import { ThreadMetaChips } from "./ThreadMetaChips";
import { getThreadRowStatus, ThreadRowStatus } from "./ThreadRowStatus";
import { setThreadRowNativeDragPreview } from "./thread-row-drag-preview";

const HOVER_PREFETCH_DELAY_MS = 750;
const absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

type ThreadRowProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  /** Thread keys with a live integrated terminal in the main process. */
  terminalThreadKeys?: Record<string, boolean>;
  inputRequestThreadKeys?: Record<string, boolean>;
  /**
   * Identity key → pending outbound-message state, surfaced as the
   * "Scheduled"/"Queued" chip. Absent key = no pending send.
   */
  queuedMessageThreadKeys?: Record<string, ThreadQueuedMessageState>;
  /** Threads with unsent composer text, keyed like the maps above. */
  draftThreadKeys?: Record<string, boolean>;
  /**
   * Identity key of the card the open composer was spawned from. When it
   * matches this row, the row renders as the orange "composing" source.
   */
  composerSourceThreadKey?: string;
  compact?: boolean;
  dropIndicator?: DropIndicatorPosition;
  draggable?: boolean;
  pointerDraggable?: boolean;
  includeLinkedDirectories?: boolean;
  linkedDirectoryMode?: "label" | "kind";
  nested?: boolean;
  revealSelectedThreadRequest?: number;
  selectedThreadKey?: string;
  /**
   * The rows currently selected for a sidebar batch action. This is separate
   * from `selectedThreadKey`, which still identifies the thread open in the
   * detail pane while the user builds a multi-selection.
   */
  selectedThreadKeys?: ReadonlySet<string>;
  subthreadCount?: number;
  subthreadsCollapsed?: boolean;
  thinkingThreadKeys?: Record<string, boolean>;
  threadPinState?: "pinned" | "unpinned";
  thread: NavigationThreadSummary;
  onOpenContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number; anchorTop?: number }
  ) => void;
  onOpenPullRequestContextMenu?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
    position: { x: number; y: number; anchorTop?: number }
  ) => void;
  /**
   * Fired after a 750ms hover over a non-merged PR chip. The parent
   * decides whether to actually issue an IPC fetch (e.g. dedupe by
   * thread key, respect terminal-state short-circuit on the main side).
   */
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  /** Fired with the same hover intent signal to refresh local Git state. */
  onPrefetchGitWorkingState?: (thread: NavigationThreadSummary) => void;
  onDetachPullRequest?: (
    thread: NavigationThreadSummary,
    pr: PrSummary,
  ) => void;
  /**
   * Called when the user picks "Unbind" from a per-thread messaging
   * binding chip. Receives the binding id; the parent owns the IPC call
   * and any optimistic UI rollback.
   */
  onUnbindMessagingBinding?: (
    thread: NavigationThreadSummary,
    binding: MessagingThreadBindingSummary,
  ) => Promise<void>;
  onSelectThread: (
    thread: NavigationThreadSummary,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  onRevealSelectedThreadComplete?: (request: number) => void;
  onToggleSubthreads?: () => void;
  onDragStartThread?: (event: DragEvent<HTMLDivElement>) => void;
  onDragOverThread?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeaveThread?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEndThread?: (event: DragEvent<HTMLDivElement>) => void;
  onDropOnThread?: (event: DragEvent<HTMLDivElement>) => void;
  onPointerDownThread?: (event: PointerEvent<HTMLDivElement>) => void;
  onMovePinnedThread?: (
    thread: NavigationThreadSummary,
    direction: "up" | "down",
  ) => void;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onSetThreadPin?: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  onOpenPullRequest?: (url: string) => void;
};

export function ThreadRow(props: ThreadRowProps) {
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  const selected = props.selectedThreadKeys
    ? props.selectedThreadKeys.has(threadKey)
    : threadKey === props.selectedThreadKey;
  const active = threadKey === props.selectedThreadKey;
  const isComposerSource = threadKey === props.composerSourceThreadKey;
  // A remote-owned row whose peer isn't currently connected renders dimmed:
  // the data shown is the last-known snapshot, not live.
  const isRemoteOffline = Boolean(
    props.thread.federation?.peerStatus
    && props.thread.federation.peerStatus !== "connected",
  );
  const status = getThreadRowStatus(props.thread, props.thinkingThreadKeys);
  const [pickerOpen, setPickerOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const completedRevealRequestRef = useRef(0);
  const revealSelectedThreadRequest = props.revealSelectedThreadRequest ?? 0;
  const onRevealSelectedThreadComplete =
    props.onRevealSelectedThreadComplete;
  const addReactionRef = useRef<HTMLSpanElement>(null);
  const reactions = props.thread.reactions ?? [];
  const canReact = Boolean(props.onSetReaction);
  const onSetThreadPin = props.onSetThreadPin;
  const bindings = props.thread.messagingBindings ?? [];
  // Pull straight from the navigation snapshot — main persists PR state
  // to the overlay store and surfaces it through the snapshot, so the
  // chips render instantly on app launch and stay in sync without any
  // renderer-side cache.
  const prs = props.thread.prs ?? [];
  const openPr = props.onOpenPullRequest ?? defaultOpenPullRequest;
  // Hover prefetch: 750ms intent timer — long enough that simply scrolling
  // past doesn't fire, short enough that a deliberate hover beats the
  // user's first click. Terminal-only PR sets still request a user
  // refresh; main owns the longer terminal-state rate limit.
  const hoverTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);
  useEffect(() => {
    if (!active) {
      return;
    }

    if (typeof rowRef.current?.scrollIntoView !== "function") {
      return;
    }

    rowRef.current.scrollIntoView({
      block: "nearest",
    });
  }, [active, threadKey]);
  useEffect(() => {
    if (!active) {
      return;
    }

    if (
      revealSelectedThreadRequest > completedRevealRequestRef.current
      && onRevealSelectedThreadComplete
    ) {
      completedRevealRequestRef.current = revealSelectedThreadRequest;
      onRevealSelectedThreadComplete(revealSelectedThreadRequest);
    }
  }, [
    onRevealSelectedThreadComplete,
    revealSelectedThreadRequest,
    active,
  ]);
  const armHoverPrefetch = (): void => {
    if (isNativeDragInteractionActive()) return;
    if (
      !props.onPrefetchPullRequests
      && !props.onPrefetchGitWorkingState
    ) {
      return;
    }
    if (hoverTimerRef.current !== undefined) return;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      if (isNativeDragInteractionActive()) return;
      if (prs.length > 0) {
        props.onPrefetchPullRequests?.(props.thread);
      }
      props.onPrefetchGitWorkingState?.(props.thread);
    }, HOVER_PREFETCH_DELAY_MS);
  };
  const cancelHoverPrefetch = (): void => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  };

  const toggleReaction = (emoji: string): void => {
    if (!props.onSetReaction) {
      return;
    }
    const present = !reactions.includes(emoji);
    void props.onSetReaction(props.thread, emoji, present);
  };

  return (
    <div
      className={`thread-row-shell${
        props.draggable || props.pointerDraggable ? " is-draggable" : ""
      }${
        props.dropIndicator ? ` is-drop-target-${props.dropIndicator}` : ""
      }${props.nested ? " thread-row-shell--nested" : ""}${
        props.subthreadCount ? " has-subthreads" : ""
      }`}
      draggable={props.draggable}
      data-thread-pin-key={props.threadPinState ? threadKey : undefined}
      data-thread-pin-state={props.threadPinState}
      role="listitem"
      onDragStart={(event) => {
        if (props.draggable) {
          setThreadRowNativeDragPreview(event);
        }
        props.onDragStartThread?.(event);
      }}
      onDragOver={props.onDragOverThread}
      onDragLeave={props.onDragLeaveThread}
      onDragEnd={props.onDragEndThread}
      onDrop={props.onDropOnThread}
      onPointerDown={props.onPointerDownThread}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onOpenContextMenu(props.thread, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      {props.subthreadCount && props.onToggleSubthreads ? (
        <button
          aria-expanded={!props.subthreadsCollapsed}
          aria-label={`${props.subthreadsCollapsed ? "Expand" : "Collapse"} sub-threads for ${props.thread.title}`}
          className={`thread-row__subthread-toggle${
            props.subthreadsCollapsed ? "" : " is-open"
          }`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleSubthreads?.();
          }}
        />
      ) : null}
      <div
        ref={rowRef}
        className={`thread-row${props.compact ? " thread-row--compact" : ""}${
          selected ? " is-selected" : ""
        }${isComposerSource ? " is-composer-source" : ""}${
          isRemoteOffline ? " is-remote-offline" : ""
        }`}
      >
        {/* The card's primary action. It carries the title line and
            stretches over the whole card via `.thread-row__open::after`
            (see app.css), but it is a SIBLING of the chip flow rather
            than its ancestor: the chips own real buttons (copy path,
            copy branch, unpin, unbind, reactions, PR links) and a button
            inside a button is neither valid nor operable — axe reports it
            as `nested-interactive`. `.star-map-card-shell` uses the same
            shape for its kebab. */}
        <button
          // ", pinned" keeps the pinned state in the row's accessible
          // name now that the old role="img" pin chip is gone — the
          // in-title marker is aria-hidden (it sits inside this button,
          // where an interactive replacement would be invalid), and the
          // hover cluster's toggle only exists when a pin handler is
          // wired. Screen readers hear the state wherever the row
          // renders.
          aria-label={
            props.thread.pinnedRank && !props.thread.parentThreadId
              ? `${props.thread.title}, pinned`
              : props.thread.title
          }
          aria-pressed={selected}
          className="thread-row__header thread-row__open"
          type="button"
          onKeyDown={(event) => {
            // Reorder a pinned thread within its backend's pinned
            // slice. Unified with the directory-pin shortcut
            // (Cmd+Shift+Arrow) so users learn one keybind. Plain
            // Cmd+Arrow used to drive this — that collided with
            // macOS Finder's "go to parent folder" mental model and
            // diverged from the directory shortcut.
            if (
              props.onMovePinnedThread &&
              props.thread.pinnedRank &&
              event.metaKey &&
              event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              (event.key === "ArrowUp" || event.key === "ArrowDown")
            ) {
              event.preventDefault();
              props.onMovePinnedThread(
                props.thread,
                event.key === "ArrowUp" ? "up" : "down",
              );
            }
          }}
          onClick={(event) => props.onSelectThread(props.thread, event)}
        >
          <span className="thread-row__heading">
            <ThreadRowStatus status={status} />
            <span className="thread-row__title">{props.thread.title}</span>
            {/* Passive pinned-state marker on the title line (both
                densities — the pin no longer spends a chip). Inside the
                open-thread button, so no role/tabindex — a nested
                interactive control would be invalid; the ACTIONABLE pin
                toggle is the hover-revealed button in the actions
                cluster, alongside the reaction + overflow buttons. */}
            {props.thread.pinnedRank && !props.thread.parentThreadId ? (
              <span aria-hidden="true" className="thread-row__heading-pin">
                <PinIcon size={11} />
              </span>
            ) : null}
          </span>
          <span className="thread-row__time">
            {formatRelativeTime(props.thread.updatedAt)}
          </span>
        </button>

        {/* Single ordered chip flow: meta (provider / location → PR chips
            → branch / drift / git state) → messaging binding chips →
            reactions. PR chips slot into the middle of the meta flow (see
            ThreadMetaChips.prChips) so they pack right after the short
            fixed-width chips instead of trailing the branch — the longest,
            least-scanned string on the row. flex-wrap handles overflow
            naturally; the hover-only add-reaction affordance is positioned
            outside the flow so it cannot reserve a phantom wrapped row
            while hidden.

            The container is `pointer-events: none` (see app.css) so the
            gaps between chips fall through to the open-thread overlay, so
            these hover handlers fire when the pointer enters a CHIP —
            React synthesizes enter/leave along the ancestor path — not
            when it enters the container's empty space. That matches what
            the prefetch is for; just don't read it as "hovered the row". */}
        <span
          className="thread-row__chips"
          onMouseEnter={
            prs.length > 0 || props.onPrefetchGitWorkingState
              ? armHoverPrefetch
              : undefined
          }
          onMouseLeave={
            prs.length > 0 || props.onPrefetchGitWorkingState
              ? cancelHoverPrefetch
              : undefined
          }
        >
          <ThreadMetaChips
            hasApprovalRequest={props.approvalRequestThreadKeys?.[threadKey] === true}
            hasIntegratedTerminal={props.terminalThreadKeys?.[threadKey] === true}
            hasInputRequest={props.inputRequestThreadKeys?.[threadKey] === true}
            queuedMessageState={props.queuedMessageThreadKeys?.[threadKey]}
            hasUnsentDraft={props.draftThreadKeys?.[threadKey] === true}
            includeLinkedDirectories={props.includeLinkedDirectories}
            linkedDirectoryMode={props.linkedDirectoryMode}
            prChips={prs.map((pr) => (
              <PrChip
                key={pr.url}
                pr={pr}
                showRepoPrefix={needsRepoPrefix(props.thread, pr, prs)}
                onOpen={openPr}
                onOpenContextMenu={
                  props.onOpenPullRequestContextMenu
                    ? (targetPr, position) =>
                        props.onOpenPullRequestContextMenu!(
                          props.thread,
                          targetPr,
                          position,
                        )
                    : undefined
                }
                onDetach={
                  props.onDetachPullRequest
                    ? (targetPr) =>
                        props.onDetachPullRequest!(props.thread, targetPr)
                    : undefined
                }
              />
            ))}
            thread={props.thread}
          />

          {bindings.map((binding) => (
            <BindingChip
              key={binding.bindingId}
              binding={binding}
              onUnbind={
                props.onUnbindMessagingBinding
                  ? (target) =>
                      void props.onUnbindMessagingBinding!(props.thread, target)
                  : undefined
              }
            />
          ))}

          {reactions.map((emoji) => (
            <ReactionChip
              key={emoji}
              emoji={emoji}
              onToggle={() => toggleReaction(emoji)}
            />
          ))}
        </span>

      </div>

      <div className="thread-row__actions">
        {/* Hover-revealed pin toggle: pin an unpinned thread, unpin a
            pinned one. Lives with the other row actions instead of in
            the chip flow, so the pinned STATE costs no chip space (the
            in-title marker carries it) and pinning gains a one-click
            affordance it never had. Sub-threads cannot be pinned. */}
        {onSetThreadPin && !props.thread.parentThreadId ? (
          <button
            aria-label={
              props.thread.pinnedRank ? "Unpin thread" : "Pin thread"
            }
            aria-pressed={Boolean(props.thread.pinnedRank)}
            className={`thread-row__pin-button${
              props.thread.pinnedRank ? " is-pinned" : ""
            }`}
            title={props.thread.pinnedRank ? "Unpin thread" : "Pin thread"}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void onSetThreadPin(props.thread, !props.thread.pinnedRank);
            }}
          >
            <PinIcon size={12} aria-hidden="true" />
          </button>
        ) : null}

        {canReact ? (
          <AddReactionChip
            anchorRef={addReactionRef}
            open={pickerOpen}
            onToggle={() => setPickerOpen((open) => !open)}
          />
        ) : null}

        <button
          aria-haspopup="menu"
          aria-label="Open thread actions"
          className="thread-row__overflow-button"
          title={`Open thread actions for ${props.thread.title}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            props.onOpenContextMenu(props.thread, {
              x: rect.left,
              y: rect.bottom + 4,
              anchorTop: rect.top,
            });
          }}
        >
          ...
        </button>
      </div>

      {canReact ? (
        <ReactionPicker
          open={pickerOpen}
          current={reactions}
          anchorRef={addReactionRef}
          onSelect={(emoji) => {
            toggleReaction(emoji);
            setPickerOpen(false);
          }}
          onDismiss={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ReactionChip(props: { emoji: string; onToggle: () => void }) {
  const { emoji, onToggle } = props;
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Remove reaction ${emoji} from thread`}
      className="thread-row__chip thread-row__chip--reaction thread-row__chip--persistent"
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          handleActivate(event);
        }
      }}
    >
      <span aria-hidden="true">{emoji}</span>
    </span>
  );
}

function AddReactionChip(props: {
  open: boolean;
  anchorRef: React.RefObject<HTMLSpanElement | null>;
  onToggle: () => void;
}) {
  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    props.onToggle();
  };
  return (
    <span
      ref={props.anchorRef}
      role="button"
      tabIndex={0}
      aria-haspopup="menu"
      aria-expanded={props.open}
      aria-label="Add reaction to thread"
      className={`thread-row__chip thread-row__chip--add-reaction${
        props.open ? " is-open" : ""
      }`}
      onClick={handleActivate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          handleActivate(event);
        }
      }}
    >
      {/* Stroke-based icon — matches the rest of the icon set and
          inherits the chip's foreground color, instead of the OS
          emoji's bright yellow which fought the dark theme. */}
      <SmileyIcon size={14} aria-hidden="true" />
    </span>
  );
}

function BindingChip(props: {
  binding: MessagingThreadBindingSummary;
  onUnbind?: (binding: MessagingThreadBindingSummary) => void;
}) {
  const { binding, onUnbind } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tooltipController = useViewportTooltip({
    className: "viewport-tooltip",
  });
  const Icon = MESSAGING_PLATFORM_ICONS[binding.platform];
  const platformLabel = formatMessagingPlatformName(binding.platform);
  const label = formatBindingLabel(binding);
  const tooltip = formatBindingTooltip(binding);
  // aria-label needs to be a single line (screen readers), so flatten
  // the multi-line tooltip into a comma-separated form.
  const ariaTooltip = tooltip.replace(/\n/g, ", ");
  const ariaLabel = onUnbind
    ? `Open binding actions for ${ariaTooltip}`
    : ariaTooltip;

  // Dismiss the menu on outside click or Escape — same pattern as the
  // reaction picker. Capture-phase listener so we close before the
  // row's click handler fires.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: globalThis.MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const handleActivate = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!onUnbind) return;
    setMenuOpen((open) => !open);
  };

  return (
    // Portal-rendered tooltip via useViewportTooltip — escapes the
    // sidebar scroll container's overflow clip and clamps to viewport
    // bounds. CSS-pseudo tooltip-target wouldn't work here: the
    // sidebar scroll region clips ::after pseudo-elements.
    <span ref={wrapRef} className="thread-row__chip-wrap">
      <span
        role="button"
        tabIndex={onUnbind ? 0 : -1}
        className="thread-row__chip thread-row__chip--binding"
        onMouseEnter={(event) => tooltipController.show(event.currentTarget, tooltip)}
        onMouseLeave={tooltipController.hide}
        onFocus={(event) => tooltipController.show(event.currentTarget, tooltip)}
        onBlur={tooltipController.hide}
        aria-label={ariaLabel}
        aria-haspopup={onUnbind ? "menu" : undefined}
        aria-expanded={onUnbind ? menuOpen : undefined}
        aria-disabled={onUnbind ? undefined : true}
        onClick={onUnbind ? handleActivate : undefined}
        onKeyDown={
          onUnbind
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  handleActivate(event);
                }
              }
            : undefined
        }
      >
        {Icon ? (
          <Icon size={12} />
        ) : (
          <span aria-hidden="true">{binding.platform.slice(0, 2)}</span>
        )}
        <span className="thread-row__chip-label">{label}</span>
      </span>
      {menuOpen && onUnbind ? (
        <div
          role="menu"
          className="thread-row__chip-menu"
          aria-label={`Actions for ${ariaTooltip}`}
        >
          <span
            tabIndex={0}
            role="menuitem"
            className="thread-row__chip-menu-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onUnbind(binding);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(false);
                onUnbind(binding);
              }
            }}
          >
            Unbind from {platformLabel}
          </span>
          <p className="thread-row__chip-menu-hint">
            Removes the binding from this app. To stop the conversation
            entirely, also unbind from {platformLabel}.
          </p>
        </div>
      ) : null}
      {tooltipController.tooltipNode}
    </span>
  );
}

const CHIP_LEAF_MAX_CHARS = 20;

function elide(value: string, max = CHIP_LEAF_MAX_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Chip label: pure ancestry breadcrumb. The leaf segment is elided to
 * ~20 chars so a long topic/thread name doesn't blow up the row width.
 * Earlier ancestors stay full-length (they're typically short — server
 * names, channel names) and are critical for context.
 *
 *   DM       →  <peer>            (or "Direct message" if no peer)
 *   topic    →  <supergroup>/<topic-elided>
 *                or <supergroup>/Topic        when topic name unknown
 *                or Topic                      when neither is known
 *   channel  →  Telegram: <group>            (or "Group")
 *               Discord:  <server>/#<channel>
 *   thread   →  Discord: <server>/#<channel>/<thread-elided>
 */
/**
 * A Slack multi-person DM (mpim) is stored as conversationKind "channel"
 * (the routing key can't distinguish it), but its resolved title is always
 * Slack's reserved `mpdm-…` name — so the display can classify it as a group
 * DM rather than mislabelling it "Channel" / "Server channel".
 */
function isSlackGroupDmBinding(
  binding: MessagingThreadBindingSummary,
): boolean {
  return (
    binding.platform === "slack"
    && binding.conversationKind === "channel"
    && (binding.conversationTitle?.trim().toLowerCase().startsWith("mpdm") ?? false)
  );
}

/** Best-effort member list from an mpdm title (`mpdm-a--b--c-1` → "a, b, c"). */
function slackGroupDmMembers(title: string): string {
  return title
    .trim()
    .replace(/^mpdm-/i, "")
    .replace(/-\d+$/, "")
    .split("--")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function formatBindingLabel(binding: MessagingThreadBindingSummary): string {
  const title = binding.conversationTitle?.trim();
  const parent = binding.parentTitle?.trim();
  const ancestor = binding.ancestorTitle?.trim();
  const platform = binding.platform;

  if (isSlackGroupDmBinding(binding)) {
    const members = title ? slackGroupDmMembers(title) : "";
    return members ? `Group DM: ${elide(members, 22)}` : "Group DM";
  }

  switch (binding.conversationKind) {
    case "dm":
      return title ? elide(title) : "Direct message";
    case "topic":
      // Topic name alone is usually our own desktop thread title —
      // redundant with the row title shown directly above the chip.
      // Only show topic name when we ALSO have the supergroup parent
      // so the breadcrumb actually carries the supergroup context.
      // Without parent, fall back to literal "Topic".
      if (parent) {
        return title ? `${parent}/${elide(title)}` : `${parent}/Topic`;
      }
      return "Topic";
    case "thread":
      if (ancestor && parent) {
        return title
          ? `${ancestor}/#${parent}/${elide(title)}`
          : `${ancestor}/#${parent}/Thread`;
      }
      if (parent) {
        return title ? `#${parent}/${elide(title)}` : `#${parent}/Thread`;
      }
      return "Thread";
    case "channel":
      if (platform === "telegram") {
        // For Telegram non-topic chats, the title IS the
        // (super)group name — that's the breadcrumb itself.
        return title ? elide(title, 28) : "Group";
      }
      if (platform === "slack") {
        return title ? `#${elide(title, 28)}` : "Channel";
      }
      // Discord. Thread messages are still kind="channel" (kind drives
      // binding lookup, can't change), so we distinguish by data
      // shape: ancestorTitle populated → it's a thread (3-level).
      // Layout:
      //   thread:  <server>/#<channel>/<thread-elided>
      //   channel: <server>/#<channel>
      //   bare:    Channel
      if (ancestor && parent && title) {
        return `${ancestor}/#${parent}/${elide(title)}`;
      }
      if (parent && title) return `${parent}/#${elide(title, 22)}`;
      if (parent) return `${parent}/Channel`;
      return "Channel";
    default:
      // Pre-kind legacy bindings — best effort.
      return title ? elide(title) : binding.platform;
  }
}

/**
 * Tooltip is multi-line: platform first, then conversation type, then
 * each available ancestry segment labelled by its role on that
 * platform. Renders nothing for fields the adapter hasn't populated.
 * `\n` is honored by browser native title-attribute tooltips.
 */
function formatBindingTooltip(binding: MessagingThreadBindingSummary): string {
  const lines: string[] = [];
  lines.push(formatMessagingPlatformName(binding.platform));
  lines.push(`Type: ${formatConversationType(binding)}`);

  const title = binding.conversationTitle?.trim();
  const parent = binding.parentTitle?.trim();
  const ancestor = binding.ancestorTitle?.trim();
  const platform = binding.platform;

  switch (binding.conversationKind) {
    case "dm":
      if (title) lines.push(`Peer: ${title}`);
      break;
    case "topic":
      if (parent) lines.push(`SuperGroup: ${parent}`);
      if (title) lines.push(`Topic: ${title}`);
      break;
    case "thread":
      if (ancestor) lines.push(`Server: ${ancestor}`);
      if (parent) lines.push(`Channel: #${parent}`);
      if (title) lines.push(`Thread: ${title}`);
      break;
    case "channel":
      if (isSlackGroupDmBinding(binding)) {
        const members = title ? slackGroupDmMembers(title) : "";
        if (members) lines.push(`With: ${members}`);
      } else if (platform === "telegram") {
        if (title) lines.push(`Group: ${title}`);
      } else if (ancestor) {
        // Discord thread — 3 levels: server / channel / thread.
        // The kind stays "channel" for routing; thread is inferred from
        // ancestorTitle being populated.
        lines.push(`Server: ${ancestor}`);
        if (parent) lines.push(`Channel: #${parent}`);
        if (title) lines.push(`Thread: ${title}`);
      } else {
        // Discord regular guild channel — 2 levels: server / channel.
        if (parent) lines.push(`Server: ${parent}`);
        if (title) lines.push(`Channel: #${title}`);
      }
      break;
    default:
      if (title) lines.push(`Title: ${title}`);
      break;
  }
  return lines.join("\n");
}

function formatConversationType(binding: MessagingThreadBindingSummary): string {
  if (isSlackGroupDmBinding(binding)) return "Group DM";
  const platform = binding.platform;
  switch (binding.conversationKind) {
    case "dm":
      return "Direct message";
    case "topic":
      return "SuperGroup topic";
    case "thread":
      return "Server thread";
    case "channel":
      // Telegram lumps Group + SuperGroup into kind="channel" today
      // (we don't yet propagate chat.type). Topic-bound chats are
      // reported as kind="topic" — and topics imply a SuperGroup —
      // so when we see kind="channel" on Telegram we can't tell
      // which. Render the honest "Group or SuperGroup" until the
      // adapter starts forwarding chat.type explicitly.
      if (platform === "telegram") return "Group or SuperGroup";
      // Discord thread is also kind="channel" (the binding key
      // depends on it, can't change). Distinguish by ancestorTitle
      // being populated — see Discord adapter channelFromDiscord.
      return binding.ancestorTitle ? "Server thread" : "Server channel";
    default:
      return "Conversation";
  }
}

type RepositoryIdentity = {
  provider: string;
  org: string;
  repo: string;
};

function needsRepoPrefix(
  thread: NavigationThreadSummary,
  pr: PrSummary,
  prs: PrSummary[],
): boolean {
  // Deleted fork heads can leave retained PRs without repository metadata.
  // Never opt those chips into a prefix: PrChip would otherwise render the
  // malformed `/#123` instead of preserving the unqualified fallback.
  if (!pr.org.trim() || !pr.repo.trim()) {
    return false;
  }

  const primaryRepository = parseRepositoryIdentity(thread.gitOriginUrl);
  if (primaryRepository) {
    return repositoryIdentityKey(primaryRepository) !== repositoryIdentityKey(pr);
  }

  if (prs.length <= 1) {
    return false;
  }
  const firstKey = `${prs[0]!.org}/${prs[0]!.repo}`;
  return prs.some((pr) => `${pr.org}/${pr.repo}` !== firstKey);
}

function parseRepositoryIdentity(
  remoteUrl?: string,
): RepositoryIdentity | undefined {
  const value = remoteUrl?.trim();
  if (!value) {
    return undefined;
  }

  const scpLike = value.match(/^[^@/]+@([^:]+):(.+)$/);
  let provider: string;
  let path: string;
  if (scpLike) {
    provider = scpLike[1]!;
    path = scpLike[2]!;
  } else {
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) {
        return undefined;
      }
      provider = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }

  const segments = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }

  const repo = segments.at(-1);
  const org = segments.slice(0, -1).join("/");
  if (!org || !repo) {
    return undefined;
  }

  return { provider, org, repo };
}

function repositoryIdentityKey(identity: RepositoryIdentity): string {
  return [
    normalizeRepositoryProvider(identity.provider),
    identity.org,
    identity.repo,
  ]
    .map((part) => part.trim().toLowerCase())
    .join("/");
}

function normalizeRepositoryProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  // GitHub documents ssh.github.com:443 as an alternate SSH transport for
  // networks that block port 22. PR URLs still identify that forge as
  // github.com, so compare both hostnames as the same provider.
  return normalized === "ssh.github.com" ? "github.com" : normalized;
}

function defaultOpenPullRequest(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return "now";
  }

  const deltaMinutes = Math.max(
    0,
    Math.round((Date.now() - timestamp) / (1000 * 60))
  );

  if (deltaMinutes < 1) {
    return "now";
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 7) {
    return `${deltaDays}d`;
  }

  return absoluteDateFormatter.format(timestamp);
}
