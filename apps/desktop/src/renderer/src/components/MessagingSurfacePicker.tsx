import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MessagingConversationKind } from "@pwragent/shared";
import { SearchIcon } from "../icons";

/**
 * Searchable picker for a messaging conversation.
 *
 * Shared by the Messaging Routes settings (which offers durable destinations
 * drawn from observed surfaces) and the Automations editor (which offers the
 * channels and groups an operator has authorized). The two feed it different
 * lists and name things differently, so every word it shows is a prop with a
 * routes-shaped default.
 *
 * This is the composer's project / branch picker in a Settings form, and it
 * deliberately borrows that popover's primitives rather than restating them:
 * one search row, an uppercase section eyebrow per group, and a single-line
 * row whose anatomy never varies (check column, kind glyph, name, then the
 * durable ID right-aligned in dim mono). Two destinations that share a name
 * are told apart by that ID column, which is what the native `<select>` this
 * replaced could not do.
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

type PanelPosition = {
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
function placePanel(trigger: DOMRect): PanelPosition {
  const width = Math.min(
    PANEL_MAX_WIDTH,
    Math.max(PANEL_MIN_WIDTH, trigger.width),
  );
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(trigger.left, window.innerWidth - width - VIEWPORT_PADDING),
  );
  const below = window.innerHeight - trigger.bottom - PANEL_GAP - VIEWPORT_PADDING;
  const above = trigger.top - PANEL_GAP - VIEWPORT_PADDING;
  // Flip only when the space above is genuinely better; a cramped-but-adequate
  // drop-down reads more naturally than a drop-up.
  const flip = below < 240 && above > below;
  return {
    width,
    left,
    flipped: flip,
    top: flip ? trigger.top - PANEL_GAP : trigger.bottom + PANEL_GAP,
    maxHeight: Math.max(160, flip ? above : below),
  };
}

type SurfaceSection = "configured" | "channel" | "dm" | "topic" | "other";

type SurfaceOption = {
  value: string;
  label: string;
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
  "other",
];

const SECTION_LABELS: Record<SurfaceSection, string> = {
  configured: "Current configuration",
  channel: "Channels & groups",
  dm: "Direct messages",
  topic: "Telegram topics",
  // Every option lands here when the caller does not group by kind, so the
  // caller names it: "Recently seen" is true of observed surfaces and false
  // of an authorized-channel list.
  other: "Recently seen",
};

/**
 * Kind glyph for the leading icon column, like the composer's folder and
 * branch marks. Only the conversation scope has one: the container scopes
 * list servers and workspaces, which are not channels, and a homogeneous
 * section stays aligned without a glyph at all.
 */
function kindGlyph(kind: MessagingConversationKind | undefined): string {
  if (kind === "dm") return "@";
  // A topic and a thread are both sub-conversations hanging off a parent. A
  // thread is no longer offered, but a route saved before that reaches this
  // list as the current configuration and must not be marked as a channel.
  if (kind === "topic" || kind === "thread") return "▸";
  return "#";
}

function sectionFor(option: SurfaceOption, grouped: boolean): SurfaceSection {
  if (option.section) return option.section;
  if (!grouped) return "other";
  if (option.kind === "dm") return "dm";
  // Threads share the topic heading rather than falling through to channels:
  // `kindGlyph` already marks both as sub-conversations, and a row whose
  // heading and glyph disagree is worse than one filed a little loosely.
  if (option.kind === "topic" || option.kind === "thread") return "topic";
  return "channel";
}

export function MessagingSurfacePicker(props: {
  value: string;
  options: SurfaceOption[];
  /** Group by conversation kind and drop the kinds a default route cannot target. */
  filterConversations: boolean;
  allowTopics?: boolean;
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

  const trimmed = query.trim().toLowerCase();
  const visible = props.options.filter((option) => {
    // The route's own saved destination is always offered, whatever its kind.
    // Threads stopped being selectable, but a route saved before that still
    // arrives here as the current configuration: hiding it would leave its
    // editor showing no current target, and the keyboard cursor sitting on
    // some unrelated row ready to retarget the route on the next Enter.
    if (option.value !== props.value && props.filterConversations && option.kind) {
      // Default routes target durable destinations only; an ephemeral reply
      // thread belongs to a binding, and topics are a Telegram-only concept.
      if (option.kind === "thread") return false;
      if (option.kind === "topic" && !props.allowTopics) return false;
    }
    return `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(trimmed);
  });
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));

  // Index once, then group: keeping each row's flat index lets arrow keys and
  // `aria-activedescendant` walk one continuous list across headings, and
  // resolving the section here keeps this a single pass over `visible` rather
  // than one per section on every keystroke.
  const indexed = visible.map((option, index) => ({
    option,
    index,
    section: sectionFor(option, props.filterConversations),
  }));
  const groups = SECTION_ORDER.map((key) => ({
    key,
    label: props.sectionLabels?.[key] ?? SECTION_LABELS[key],
    rows: indexed.filter((row) => row.section === key),
  })).filter((section) => section.rows.length > 0);

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
      onBlur={(event) => {
        // React routes the portalled panel's events through this handler, but
        // `contains` walks the DOM, where the panel is not a descendant — so
        // it has to be checked separately or focusing into the list would
        // close it. A null `relatedTarget` (focus leaving to nothing) is not a
        // reason to close either.
        const next = event.relatedTarget as Node | null;
        if (!next) return;
        if (event.currentTarget.contains(next) || panel.current?.contains(next)) return;
        setOpen(false);
      }}
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
        // before a choice is made.
        aria-label={`${props.fieldLabel}: ${triggerLabel}`}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => {
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
              aria-label={`Find a ${props.fieldLabel.toLowerCase()}`}
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
          <div id={listId} role="listbox" aria-label="Messaging surfaces" className="messaging-surface-picker__list">
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
                      {option.detail ? <span className="project-picker__row-path">{option.detail}</span> : null}
                      {option.seen ? <span className="messaging-surface-picker__seen">{option.seen}</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {/* Outside the listbox: assistive technology drops a non-option
              child of `role="listbox"`, which would leave a screen-reader
              user with an empty list and no explanation. */}
          {/* `role="status"` so a search that stops matching is announced.
              Outside the listbox it is reachable but silent, and a
              screen-reader user cannot tell no-match from an unresponsive
              control. */}
          {visible.length === 0 ? (
            <p role="status" className="project-picker__empty">
              {props.emptyLabel ?? "No matching surfaces."}
            </p>
          ) : null}
          <div className="project-picker__separator" />
          <button type="button" className="project-picker__row project-picker__row--action"
            onClick={() => choose("manual")}
          >
            <span aria-hidden="true" className="project-picker__row-check" />
            <span aria-hidden="true" className="project-picker__plus">+</span>
            <span className="project-picker__row-name">{manualLabel}</span>
          </button>
        </div>
      ), document.body) : null}
    </div>
  );
}
