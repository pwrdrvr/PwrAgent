import { useEffect, useId, useRef, useState } from "react";
import type { MessagingConversationKind } from "@pwragent/shared";
import { SearchIcon } from "../../icons";

/**
 * Durable-destination picker for a messaging default route.
 *
 * This is the composer's project / branch picker in a Settings form, and it
 * deliberately borrows that popover's primitives rather than restating them:
 * one search row, an uppercase section eyebrow per group, and a single-line
 * row whose anatomy never varies (check column, kind glyph, name, then the
 * durable ID right-aligned in dim mono). Two destinations that share a name
 * are told apart by that ID column, which is what the native `<select>` this
 * replaced could not do.
 *
 * Two deliberate departures from the composer pickers:
 *
 *   - The panel is anchored INLINE, not absolutely. `.settings-panel` sets
 *     `overflow: hidden` and `.settings-content` scrolls, so a floating
 *     popover would be clipped by the card it opens inside. It therefore
 *     carries no drop shadow — it is an expanded well in a form, and lighting
 *     it like something that floats over the page would be a lie.
 *   - The trigger is REPLACED by the panel rather than sitting above it, so
 *     the field never shows a stale "choose one…" placeholder while its own
 *     list is open underneath. Focus returns to the trigger when the panel
 *     closes by Escape or by choosing a row.
 *
 * Kind is carried by a section heading instead of a filter control: grouping
 * answers "which of these is a DM?" without hiding anything and without a
 * control that only exists on one platform.
 */

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

const SECTIONS: { key: SurfaceSection; label: string }[] = [
  { key: "configured", label: "Current configuration" },
  { key: "channel", label: "Channels & groups" },
  { key: "dm", label: "Direct messages" },
  { key: "topic", label: "Telegram topics" },
  { key: "other", label: "Recently seen" },
];

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
  if (option.kind === "topic") return "topic";
  return "channel";
}

export function MessagingSurfacePicker(props: {
  value: string;
  options: SurfaceOption[];
  filterConversations: boolean;
  allowTopics?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const listId = useId();
  const selected = props.options.find((option) => option.value === props.value);
  // Manual entry matches no option, so it is a choice the trigger must report
  // even though `selected` is undefined.
  const triggerChoice = Boolean(selected) || props.value === "manual";
  const triggerLabel = selected?.label
    ?? (props.value === "manual" ? "Enter an ID manually..." : "Choose a recently seen surface...");

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
  const groups = SECTIONS.map((section) => ({
    ...section,
    rows: indexed.filter((row) => row.section === section.key),
  })).filter((section) => section.rows.length > 0);

  const close = () => {
    restoreFocus.current = true;
    setOpen(false);
  };
  const choose = (value: string) => {
    props.onChange(value);
    close();
  };

  useEffect(() => {
    if (open || !restoreFocus.current) return;
    // The trigger unmounts while the panel is open, so focus has to be
    // restored after it remounts rather than inside `close`.
    restoreFocus.current = false;
    trigger.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
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
        // `relatedTarget` is null while the trigger unmounts on open — closing
        // on that would slam the panel shut the moment it appeared.
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {open ? null : (
        <button ref={trigger} type="button" className="settings-select messaging-surface-picker__trigger"
          // An `aria-label` overrides the visible text, so it has to carry the
          // current choice in every state the button can show — including
          // manual entry, which matches no option and so has no `selected`.
          aria-label={triggerChoice ? `Surface: ${triggerLabel}` : "Choose a messaging surface"}
          aria-haspopup="dialog" aria-expanded={false}
          onClick={() => {
            setQuery("");
            setActive(0);
            setOpen(true);
          }}
        >
          {triggerLabel}
        </button>
      )}
      {open ? (
        <div className="messaging-surface-picker__panel" role="dialog" aria-label="Choose a messaging surface">
          <div className="project-picker__search">
            <span aria-hidden="true" className="project-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              autoFocus
              type="text"
              className="project-picker__search-input"
              role="combobox"
              aria-label="Find a messaging surface"
              placeholder="Find a channel, DM, or ID"
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
          {visible.length === 0 ? <p className="project-picker__empty">No matching surfaces.</p> : null}
          <div className="project-picker__separator" />
          <button type="button" className="project-picker__row project-picker__row--action"
            onClick={() => choose("manual")}
          >
            <span aria-hidden="true" className="project-picker__row-check" />
            <span aria-hidden="true" className="project-picker__plus">+</span>
            <span className="project-picker__row-name">Enter an ID manually...</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
