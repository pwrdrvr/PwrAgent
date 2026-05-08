import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
  PrSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import {
  DiscordIcon,
  MattermostIcon,
  SmileyIcon,
  TelegramIcon,
  type IconProps,
} from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { PrChip } from "../pr-status/PrChip";
import { ReactionPicker } from "./ReactionPicker";
import { ThreadMetaChips } from "./ThreadMetaChips";
import { getThreadRowStatus, ThreadRowStatus } from "./ThreadRowStatus";

const PLATFORM_ICONS: Partial<
  Record<MessagingThreadBindingSummary["platform"], (props: IconProps) => ReactElement>
> = {
  telegram: TelegramIcon,
  discord: DiscordIcon,
  mattermost: ({ size }) => <MattermostIcon size={size} />,
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
  const addReactionRef = useRef<HTMLSpanElement>(null);
  const reactions = props.thread.reactions ?? [];
  const canReact = Boolean(props.onSetReaction);
  const bindings = props.thread.messagingBindings ?? [];
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

        {/* Single ordered chip flow: meta (agent/mode/dir/branch/drift)
            → PR chips → messaging binding chips → reactions → add-
            reaction. flex-wrap handles overflow naturally; every chip
            is a sibling, no per-type containers. */}
        <span
          className="thread-row__chips"
          onMouseEnter={prs.length > 0 ? armHoverPrefetch : undefined}
          onMouseLeave={prs.length > 0 ? cancelHoverPrefetch : undefined}
        >
          <ThreadMetaChips
            hasApprovalRequest={props.approvalRequestThreadKeys?.[threadKey] === true}
            includeLinkedDirectories={props.includeLinkedDirectories}
            linkedDirectoryMode={props.linkedDirectoryMode}
            thread={props.thread}
          />

          {prs.map((pr) => (
            <PrChip
              key={pr.url}
              pr={pr}
              showRepoPrefix={showRepoPrefix}
              onOpen={openPr}
            />
          ))}

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

          {canReact ? (
            <AddReactionChip
              anchorRef={addReactionRef}
              open={pickerOpen}
              onToggle={() => setPickerOpen((open) => !open)}
            />
          ) : null}
        </span>
      </button>

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
      className="thread-row__chip thread-row__chip--reaction"
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
  const Icon = PLATFORM_ICONS[binding.platform];
  const platformLabel =
    binding.platform.charAt(0).toUpperCase() + binding.platform.slice(1);
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
          <button
            type="button"
            role="menuitem"
            className="thread-row__chip-menu-item"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onUnbind(binding);
            }}
          >
            Unbind from {platformLabel}
          </button>
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
function formatBindingLabel(binding: MessagingThreadBindingSummary): string {
  const title = binding.conversationTitle?.trim();
  const parent = binding.parentTitle?.trim();
  const ancestor = binding.ancestorTitle?.trim();
  const platform = binding.platform;

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
  lines.push(formatPlatformName(binding.platform));
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
      if (platform === "telegram") {
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

function formatPlatformName(platform: string): string {
  if (!platform) return "Messaging";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function formatConversationType(binding: MessagingThreadBindingSummary): string {
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
