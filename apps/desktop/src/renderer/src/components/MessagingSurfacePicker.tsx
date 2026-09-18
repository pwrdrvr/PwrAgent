import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessagingConversationKind } from "@pwragent/shared";
import { SearchIcon } from "../icons";
import { portalViewportTop } from "../lib/useViewportTooltip";

/**
 * Searchable picker for a messaging conversation.
 *
 * Shared by the Messaging Routes settings (which offers durable destinations
 * drawn from observed surfaces, and the Discord channels and threads that can
 * be given a response mode) and the Automations editor (which offers the
 * channels and groups an operator has authorized). They feed it different
 * lists and name things differently, so every word it shows is a prop with a
 * routes-shaped default.
 *
 * It deliberately borrows the composer picker's primitives rather than
 * restating them: one search row, an uppercase section eyebrow per group, and
 * a single-line row whose anatomy never varies (check column, kind glyph,
 * name, where it sits, then the durable ID right-aligned in dim mono). Two
 * destinations that share a name are told apart by that ID column, which is
 * what the native `<select>` it replaced on both screens could not do.
 *
 * The name is the surface's OWN name — a thread's, not its server's — and the
 * containers it sits in follow it, dimmed. A label written as one path
 * ("Discord / server / channel / thread") put the part that differs from row
 * to row at the end, where the ellipsis lands, so a column of threads read as
 * a column of identical server names. Leading with the name keeps it whole and
 * lined up down the list; the path gives way first, then the name, and the ID
 * never does, because a cut-off ID cannot tell anything apart. Callers leave
 * the platform out: every list here holds one platform, and the field beside
 * it already says which.
 *
 * It opens as a POPOVER over the page, like the pickers it copies. That takes
 * a portal: `.settings-panel` sets `overflow: hidden` and both
 * `.settings-content` and the Automations pane scroll, so a panel positioned
 * inside the field is clipped by the card it opens in. The composer pickers
 * have no such ancestor and can stay `position: absolute`; here the panel
 * renders into `document.body` and is positioned `fixed` against the
 * trigger's rect, which is the only way to escape a clipping ancestor without
 * pushing the form around.
 *
 * Kind is carried by a section heading instead of a filter control: grouping
 * answers "which of these is a DM?" without hiding anything and without a
 * control that only exists on one platform.
 */

/** Gap between the trigger and the panel, matching the composer pickers. */
const PANEL_GAP = 6;
const VIEWPORT_PADDING = 12;
/** Widths the branch picker uses; a panel narrower than this cannot show a
 *  name and an ID on one line. */
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 560;
/** The branch picker's ceiling. Without one the panel grows to whatever the
 *  viewport allows, and a tall window turns twenty rows into a dropdown that
 *  covers most of the screen. */
const PANEL_MAX_HEIGHT = 440;
/** Below this there is not enough room for the search row and a couple of
 *  rows, so a flip is worth considering. */
const PANEL_MIN_USEFUL_HEIGHT = 160;

export type PanelPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** Pinned by its bottom edge above the trigger, so it grows upward. */
  flipped: boolean;
};

/**
 * Place the panel against the trigger in viewport coordinates: below it when
 * there is room, above when there is not, and clamped so neither edge leaves
 * the window. Returns the height available too, so a long list scrolls inside
 * the panel instead of running off-screen.
 */
export function placePanel(trigger: DOMRect): PanelPosition {
  // A narrow window wins over the minimum: a panel wider than the viewport
  // cannot be clamped into it, and `left` alone cannot rescue that.
  const width = Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, trigger.width),
    Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2),
  );
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(trigger.left, window.innerWidth - width - VIEWPORT_PADDING),
  );
  // Not the raw viewport top: on Windows a fixed title bar owns the first
  // 40px, and on macOS the traffic lights sit inside the renderer. A flipped
  // panel would otherwise grow underneath one or over the other.
  const ceiling = portalViewportTop();
  const floor = window.innerHeight - VIEWPORT_PADDING;
  const below = floor - trigger.bottom - PANEL_GAP;
  const above = trigger.top - PANEL_GAP - ceiling;
  // Flip only when the space above is genuinely better; a cramped-but-adequate
  // drop-down reads more naturally than a drop-up.
  const flip = below < 240 && above > below;
  const available = Math.max(PANEL_MIN_USEFUL_HEIGHT, flip ? above : below);
  const maxHeight = Math.min(PANEL_MAX_HEIGHT, available);
  // Clamp the anchor into view as well as the size. `reposition` runs on every
  // scroll, so a trigger scrolled out of its pane would otherwise drag the
  // panel off-screen while it is still open and holding focus. The clamp is
  // against `maxHeight`, not `available`: a trigger far above the viewport
  // leaves a huge `available`, and clamping to `floor - available` would park
  // the panel thousands of pixels off the top.
  //
  // A flipped panel is pinned by its BOTTOM edge at `top` and grows upward, so
  // its bounds are [top - maxHeight, top]; an unflipped one occupies
  // [top, top + maxHeight]. Hence the two different clamps.
  const top = flip
    ? Math.min(Math.max(trigger.top - PANEL_GAP, ceiling + maxHeight), floor)
    : Math.max(Math.min(trigger.bottom + PANEL_GAP, floor - maxHeight), ceiling);
  return { width, left, top, maxHeight, flipped: flip };
}

type SurfaceSection = "configured" | "channel" | "dm" | "topic" | "thread" | "other";

type SurfaceOption = {
  value: string;
  /** The surface's own name. Shown whole unless the row cannot fit it. */
  label: string;
  /**
   * The containers it sits in, outermost first ("server / parent channel").
   * Dimmed after the name, and the first thing on the row to truncate.
   * Matched by the search as a path ahead of the name.
   */
  context?: string;
  /** Durable identifier, right-aligned in mono. Also matched by the search. */
  detail?: string;
  /** Trailing recency label. */
  seen?: string;
  /** Overrides the kind-derived section. */
  section?: SurfaceSection;
  kind?: MessagingConversationKind;
};

const SECTION_ORDER: SurfaceSection[] = [
  "configured",
  "channel",
  "dm",
  "topic",
  "thread",
  "other",
];

const SECTION_LABELS: Record<SurfaceSection, string> = {
  configured: "Current configuration",
  channel: "Channels & groups",
  dm: "Direct messages",
  topic: "Telegram topics",
  thread: "Threads",
  // Every option lands here when the caller does not group by kind, so the
  // caller names it: "Recently seen" is true of observed surfaces and false
  // of an authorized-channel list.
  other: "Recently seen",
};

/**
 * Kind glyph for the leading icon column, like the composer's folder and
 * branch marks. Only rendered when the caller groups by kind
 * (`filterConversations`): a list that is not grouped is homogeneous — route
 * container scopes are servers and workspaces rather than channels, and the
 * topic list is all topics — and stays aligned without a glyph at all.
 */
function kindGlyph(kind: MessagingConversationKind | undefined): string {
  if (kind === "dm") return "@";
  // A topic and a thread are both sub-conversations hanging off a parent, and
  // neither may be marked as a channel — including a thread route saved before
  // default routes stopped offering threads, which still reaches this list as
  // the current configuration.
  if (kind === "topic" || kind === "thread") return "▸";
  return "#";
}

function sectionFor(option: SurfaceOption, grouped: boolean): SurfaceSection {
  if (option.section) return option.section;
  if (!grouped) return "other";
  if (option.kind === "dm") return "dm";
  // Threads get their own heading rather than the topic one: "Telegram
  // topics" is false of a Discord thread, and relabelling that bucket would
  // silently merge the two for a caller that offers both.
  if (option.kind === "topic") return "topic";
  if (option.kind === "thread") return "thread";
  return "channel";
}

export function MessagingSurfacePicker(props: {
  value: string;
  options: SurfaceOption[];
  /** Group by conversation kind and drop the kinds a default route cannot target. */
  filterConversations: boolean;
  allowTopics?: boolean;
  /**
   * Keep threads when grouping by kind. A default route never targets one —
   * it belongs to a binding — but a per-thread setting such as Discord's
   * response mode exists precisely to single one out.
   */
  allowThreads?: boolean;
  /**
   * Offer the "Enter an ID manually..." action. Defaults to true. A list that
   * adds only surfaces it already knows (so it can store a name beside the ID)
   * has nothing to do with a typed one, and an action that silently does
   * nothing is worse than none.
   */
  allowManual?: boolean;
  /**
   * Refuse to open. Rendered as `aria-disabled` rather than `disabled`: a
   * focused button that becomes `disabled` drops focus to `<body>` in
   * Chromium and does not get it back on re-enable. A caller that disables
   * the field while the choice it just made is saving would otherwise lose
   * the operator's place on every pick.
   */
  disabled?: boolean;
  /**
   * The field's name, e.g. "Surface" or "Destination channel". An
   * `aria-label` replaces the button's visible text, so the name has to carry
   * both halves — without it, three pickers on one Automations form all
   * announce identically and a screen-reader user cannot tell them apart.
   */
  fieldLabel: string;
  /** Trigger text before anything is chosen. */
  placeholder?: string;
  /** Search-row placeholder. */
  searchPlaceholder?: string;
  /**
   * Search-row accessible name. The default, "Find a <field>", reads only
   * when the field is named by a noun ("Surface", "Destination").
   */
  searchLabel?: string;
  /** Action-row text, and the label the trigger shows once it is chosen. */
  manualLabel?: string;
  /**
   * Overrides for the section headings. Automations offers only the
   * conversations an operator has authorized, and the heading is where that
   * is said — a short list is then explained rather than suspicious.
   */
  sectionLabels?: Partial<Record<SurfaceSection, string>>;
  /** Message shown when the search matches nothing. */
  emptyLabel?: string;
  onChange: (value: string) => void;
}) {
  const placeholder = props.placeholder ?? "Choose a recently seen surface...";
  const manualLabel = props.manualLabel ?? "Enter an ID manually...";
  const allowManual = props.allowManual ?? true;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const listId = useId();
  const selected = props.options.find((option) => option.value === props.value);
  // Only an empty value is "nothing chosen". Manual entry never matches an
  // option, and a listed option can disappear while the editor is open (the
  // routes provider reloads observed surfaces on every bindings change) — in
  // both cases the form still holds that destination, so falling through to
  // the placeholder would deny a selection Save is about to write. The
  // dropped-out case has no label left to show, so it says so rather than
  // showing an encoded value or claiming the field is unset.
  const triggerLabel = selected?.label
    ?? (props.value === "" ? placeholder
      : props.value === "manual" ? manualLabel
      : "Selected (no longer listed)");
  // The closed field reads like the row that was chosen: the name alone would
  // not say which server's #general a route targets.
  const triggerContext = selected?.context;

  const trimmed = query.trim().toLowerCase();
  const matching = props.options.filter((option) => {
    // The route's own saved destination is always offered, whatever its kind.
    // Threads stopped being selectable, but a route saved before that still
    // arrives here as the current configuration: hiding it would leave its
    // editor showing no current target, and the keyboard cursor sitting on
    // some unrelated row ready to retarget the route on the next Enter.
    if (option.value !== props.value && props.filterConversations && option.kind) {
      // Default routes target durable destinations only; an ephemeral reply
      // thread belongs to a binding, and topics are a Telegram-only concept.
      if (option.kind === "thread" && !props.allowThreads) return false;
      if (option.kind === "topic" && !props.allowTopics) return false;
    }
    // The context is matched as the path it abbreviates, so a query typed the
    // way these surfaces are written elsewhere ("planning / cider") still hits.
    const path = option.context ? `${option.context} / ${option.label}` : option.label;
    return `${path} ${option.detail ?? ""}`.toLowerCase().includes(trimmed);
  });

  // Group, then index in DISPLAY order. Arrow keys, Enter and
  // `aria-activedescendant` walk one continuous list across headings, and it
  // has to be the list on screen: callers pass their own order — usually
  // recency — which interleaves kinds, so indexing the input sent the cursor
  // from the first channel to a thread under a later heading. Bucketing first
  // keeps this a single pass over the matches on every keystroke.
  const bySection = new Map<SurfaceSection, SurfaceOption[]>();
  for (const option of matching) {
    const section = sectionFor(option, props.filterConversations);
    const bucket = bySection.get(section);
    if (bucket) bucket.push(option);
    else bySection.set(section, [option]);
  }
  const visible: SurfaceOption[] = [];
  const groups = SECTION_ORDER.flatMap((key) => {
    const options = bySection.get(key);
    if (!options) return [];
    return [{
      key,
      label: props.sectionLabels?.[key] ?? SECTION_LABELS[key],
      rows: options.map((option) => ({ option, index: visible.push(option) - 1 })),
    }];
  });
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (value: string) => {
    props.onChange(value);
    close();
  };

  const reposition = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition(placePanel(rect));
  }, []);

  // Before paint, so the panel never renders at a stale position for a frame.
  useLayoutEffect(() => {
    if (open) reposition();
    else setPosition(null);
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    // Capture phase: the panel is anchored to a trigger inside a scrolling
    // pane, and a scroll event on that pane does not bubble to window.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      // The panel is portalled out of `root`, so it needs its own containment
      // check — DOM ancestry no longer follows the React tree.
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, listId]);

  return (
    <div ref={root} className="messaging-surface-picker"
      // Deliberately no blur handler. Closing on focus-out cannot be done
      // safely here: the panel's search input takes focus via `autoFocus`
      // during React's MUTATION phase, while `ref={panel}` is assigned in the
      // LAYOUT phase that runs after it. The blur therefore fires while
      // `panel.current` is still null, and any containment check that consults
      // it closes the panel in the frame it opened — it flashed and vanished.
      // `pointerdown` outside and Escape are what the composer pickers use,
      // and they have no such ordering hazard.
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button ref={trigger} type="button" className="settings-select messaging-surface-picker__trigger"
        // An `aria-label` overrides the visible text, so it has to carry both
        // the field's name and whatever the button currently shows — the
        // placeholder included, since that text is the button's only content
        // before a choice is made — and the context, after the name, in the
        // order the two are drawn.
        aria-label={`${props.fieldLabel}: ${triggerLabel}${triggerContext ? `, ${triggerContext}` : ""}`}
        aria-haspopup="dialog" aria-expanded={open}
        aria-disabled={props.disabled || undefined}
        onClick={() => {
          if (props.disabled) return;
          if (open) {
            setOpen(false);
            return;
          }
          setQuery("");
          setActive(0);
          setOpen(true);
        }}
      >
        {triggerLabel}
        {triggerContext ? (
          <span className="messaging-surface-picker__context">{triggerContext}</span>
        ) : null}
      </button>
      {open && position ? createPortal((
        <div
          ref={panel}
          className="messaging-surface-picker__panel"
          role="dialog"
          aria-label={props.fieldLabel}
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            // A flipped panel is pinned by its BOTTOM edge to the gap above the
            // trigger, so it grows upward as rows are added. `placePanel`
            // decided this from the rect it measured — recomputing it here
            // would be a layout read during render, against a rect that may
            // already have moved.
            transform: position.flipped ? "translateY(-100%)" : undefined,
          }}
        >
          <div className="project-picker__search">
            <span aria-hidden="true" className="project-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              autoFocus
              type="text"
              className="project-picker__search-input"
              role="combobox"
              aria-label={props.searchLabel ?? `Find a ${props.fieldLabel.toLowerCase()}`}
              placeholder={props.searchPlaceholder ?? "Find a channel, DM, or ID"}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={visible.length ? `${listId}-${activeIndex}` : undefined}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(Math.max(0, Math.min(visible.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))));
                } else if (event.key === "Enter" && visible[activeIndex]) {
                  event.preventDefault();
                  choose(visible[activeIndex].value);
                }
              }}
            />
          </div>
          <div id={listId} role="listbox" aria-label={`${props.fieldLabel} options`} className="messaging-surface-picker__list">
            {groups.map((section) => (
              <div key={section.key} role="group" aria-label={section.label}>
                <div aria-hidden="true" className="project-picker__section">{section.label}</div>
                {section.rows.map(({ option, index }) => {
                  const glyph = props.filterConversations ? kindGlyph(option.kind) : undefined;
                  const isSelected = props.value === option.value;
                  return (
                    <button type="button" role="option" id={`${listId}-${index}`} key={option.value}
                      aria-selected={isSelected}
                      className={`project-picker__row${isSelected ? " is-active" : ""}${index === activeIndex ? " is-cursor" : ""}`}
                      onClick={() => choose(option.value)}
                    >
                      <span aria-hidden="true" className="project-picker__row-check">
                        {isSelected ? "✓" : ""}
                      </span>
                      {glyph ? (
                        <span aria-hidden="true" className="messaging-surface-picker__glyph">{glyph}</span>
                      ) : null}
                      <span className="project-picker__row-name">{option.label}</span>
                      {option.context ? (
                        <span className="messaging-surface-picker__context">{option.context}</span>
                      ) : null}
                      {option.detail ? <span className="project-picker__row-path">{option.detail}</span> : null}
                      {option.seen ? <span className="messaging-surface-picker__seen">{option.seen}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {/* Outside the listbox, because assistive technology drops a
              non-option child of `role="listbox"`; and `role="status"`,
              because outside it the text is reachable but silent. It needs
              both, or a search that stops matching leaves a screen-reader
              user unable to tell no-match from an unresponsive control. */}
          {visible.length === 0 ? (
            <p role="status" className="project-picker__empty">
              {props.emptyLabel ?? "No matching surfaces."}
            </p>
          ) : null}
          {allowManual ? (
            <>
              <div className="project-picker__separator" />
              <button type="button" className="project-picker__row project-picker__row--action"
                onClick={() => choose("manual")}
              >
                <span aria-hidden="true" className="project-picker__row-check" />
                <span aria-hidden="true" className="project-picker__plus">+</span>
                <span className="project-picker__row-name">{manualLabel}</span>
              </button>
            </>
          ) : null}
        </div>
      ), document.body) : null}
    </div>
  );
}
