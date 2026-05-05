import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { DiscordIcon, TelegramIcon, type IconProps } from "../../icons";
import { PrChip } from "../pr-status/PrChip";
import { ReactionPicker } from "./ReactionPicker";
import { ThreadMetaChips } from "./ThreadMetaChips";
import { getThreadRowStatus, ThreadRowStatus } from "./ThreadRowStatus";

const PLATFORM_ICONS: Partial<
  Record<MessagingThreadBindingSummary["platform"], (props: IconProps) => ReactElement>
> = {
  telegram: TelegramIcon,
  discord: DiscordIcon,
};

const HOVER_PREFETCH_DELAY_MS = 750;

type ThreadRowProps = {
  approvalRequestThreadKeys?: Record<string, boolean>;
  compact?: boolean;
  includeLinkedDirectories?: boolean;
  linkedDirectoryMode?: "label" | "kind";
  selectedThreadKey?: string;
  thinkingThreadKeys?: Record<string, boolean>;
  thread: NavigationThreadSummary;
  onOpenContextMenu: (
    thread: NavigationThreadSummary,
    position: { x: number; y: number; anchorTop?: number }
  ) => void;
  /**
   * Fired after a 750ms hover over a non-merged PR chip. The parent
   * decides whether to actually issue an IPC fetch (e.g. dedupe by
   * thread key, respect terminal-state short-circuit on the main side).
   */
  onPrefetchPullRequests?: (thread: NavigationThreadSummary) => void;
  /**
   * Called when the user picks "Unbind" from a per-thread messaging
   * binding chip. Receives the binding id; the parent owns the IPC call
   * and any optimistic UI rollback.
   */
  onUnbindMessagingBinding?: (
    thread: NavigationThreadSummary,
    binding: MessagingThreadBindingSummary,
  ) => Promise<void>;
  onSelectThread: (thread: NavigationThreadSummary) => void;
  onSetReaction?: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  onOpenPullRequest?: (url: string) => void;
};

export function ThreadRow(props: ThreadRowProps) {
  const threadKey = buildThreadIdentityKey(props.thread.source, props.thread.id);
  const selected =
    threadKey === props.selectedThreadKey;
  const status = getThreadRowStatus(props.thread, props.thinkingThreadKeys);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addReactionRef = useRef<HTMLButtonElement>(null);
  const reactions = props.thread.reactions ?? [];
  const canReact = Boolean(props.onSetReaction);
  // Pull straight from the navigation snapshot — main persists PR state
  // to the overlay store and surfaces it through the snapshot, so the
  // chips render instantly on app launch and stay in sync without any
  // renderer-side cache.
  const prs = props.thread.prs ?? [];
  const showRepoPrefix = needsRepoPrefix(prs);
  const openPr = props.onOpenPullRequest ?? defaultOpenPullRequest;
  const hasNonTerminalPr = prs.some(
    (pr) => pr.state !== "merged" && pr.state !== "closed",
  );
  // Hover prefetch: 750ms intent timer — long enough that simply scrolling
  // past doesn't fire, short enough that a deliberate hover beats the
  // user's first click.
  const hoverTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);
  const armHoverPrefetch = (): void => {
    if (!props.onPrefetchPullRequests) return;
    if (!hasNonTerminalPr) return;
    if (hoverTimerRef.current !== undefined) return;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      props.onPrefetchPullRequests?.(props.thread);
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
      className="thread-row-shell"
      role="listitem"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onOpenContextMenu(props.thread, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <button
        aria-pressed={selected}
        className={`thread-row${props.compact ? " thread-row--compact" : ""}${
          selected ? " is-selected" : ""
        }`}
        type="button"
        onClick={() => props.onSelectThread(props.thread)}
      >
        <span className="thread-row__header">
          <span className="thread-row__heading">
            <ThreadRowStatus status={status} />
            <span className="thread-row__title">{props.thread.title}</span>
          </span>
          <span className="thread-row__time">
            {formatRelativeTime(props.thread.updatedAt)}
          </span>
        </span>

        <ThreadMetaChips
          hasApprovalRequest={props.approvalRequestThreadKeys?.[threadKey] === true}
          includeLinkedDirectories={props.includeLinkedDirectories}
          linkedDirectoryMode={props.linkedDirectoryMode}
          thread={props.thread}
        />

        {prs.length > 0 ? (
          <span
            className="thread-row__pr-chips"
            onMouseEnter={armHoverPrefetch}
            onMouseLeave={cancelHoverPrefetch}
          >
            {prs.map((pr) => (
              <PrChip
                key={pr.url}
                pr={pr}
                showRepoPrefix={showRepoPrefix}
                onOpen={openPr}
              />
            ))}
          </span>
        ) : null}

        {(props.thread.messagingBindings ?? []).length > 0 ? (
          <span className="thread-row__binding-chips">
            {(props.thread.messagingBindings ?? []).map((binding) => (
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
          </span>
        ) : null}
      </button>

      {canReact || reactions.length > 0 ? (
        <div className="thread-row__reactions">
          {reactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Remove reaction ${emoji} from thread`}
              className="thread-row__reaction"
              onClick={(event) => {
                event.stopPropagation();
                toggleReaction(emoji);
              }}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}

          {canReact ? (
            <div className="thread-row__reaction-picker-wrap">
              <button
                ref={addReactionRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                aria-label="Add reaction to thread"
                className="thread-row__add-reaction"
                onClick={(event) => {
                  event.stopPropagation();
                  setPickerOpen((open) => !open);
                }}
              >
                <span aria-hidden="true">+</span>
              </button>
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
            </div>
          ) : null}
        </div>
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
  );
}

function BindingChip(props: {
  binding: MessagingThreadBindingSummary;
  onUnbind?: (binding: MessagingThreadBindingSummary) => void;
}) {
  const { binding, onUnbind } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const Icon = PLATFORM_ICONS[binding.platform];
  const platformLabel =
    binding.platform.charAt(0).toUpperCase() + binding.platform.slice(1);
  const detail = binding.conversationTitle
    ? `${platformLabel}: ${binding.conversationTitle}`
    : platformLabel;
  const ariaLabel = onUnbind
    ? `Open binding actions for ${detail}`
    : detail;

  // Dismiss the menu when clicking outside or pressing Escape — same
  // pattern as the reaction picker. Keep the listener tight (capture
  // phase) so we close before the row's click handler fires.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <span
      ref={wrapRef}
      className="thread-row__binding-chip-wrap"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="thread-row__binding-chip"
        title={detail}
        aria-label={ariaLabel}
        aria-haspopup={onUnbind ? "menu" : undefined}
        aria-expanded={onUnbind ? menuOpen : undefined}
        disabled={!onUnbind}
        onClick={(event) => {
          event.stopPropagation();
          if (!onUnbind) return;
          setMenuOpen((open) => !open);
        }}
      >
        {Icon ? (
          <Icon size={12} />
        ) : (
          <span aria-hidden="true">{binding.platform.slice(0, 2)}</span>
        )}
        {binding.conversationTitle ? (
          <span className="thread-row__binding-chip-label">
            {binding.conversationTitle}
          </span>
        ) : null}
      </button>
      {menuOpen && onUnbind ? (
        <div
          role="menu"
          className="thread-row__binding-chip-menu"
          aria-label={`Actions for ${detail}`}
        >
          <button
            type="button"
            role="menuitem"
            className="thread-row__binding-chip-menu-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onUnbind(binding);
            }}
          >
            Unbind from {platformLabel}
          </button>
          <p className="thread-row__binding-chip-menu-hint">
            Removes the binding from this app. To stop the conversation
            entirely, also unbind from {platformLabel}.
          </p>
        </div>
      ) : null}
    </span>
  );
}

function needsRepoPrefix(prs: PrSummary[]): boolean {
  if (prs.length <= 1) {
    return false;
  }
  const firstKey = `${prs[0]!.org}/${prs[0]!.repo}`;
  return prs.some((pr) => `${pr.org}/${pr.repo}` !== firstKey);
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

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
