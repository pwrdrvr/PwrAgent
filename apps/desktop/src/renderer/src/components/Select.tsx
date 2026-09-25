import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "../icons";
import { useDismissableLayer } from "../lib/useDismissableLayer";
import { portalViewportTop } from "../lib/useViewportTooltip";

/**
 * The app's single-choice field, in place of a native `<select>`.
 *
 * On macOS, Chromium hands a `<select>` to the system menu. It opens over the
 * control with the current item aligned to it, in the system font and blue
 * highlight, and CSS cannot reach it. Windows and Linux draw Chromium's own
 * list below the control instead. So the native control was the one field in
 * the app that was neither tangerine nor Geist, and it opened differently on
 * each platform.
 *
 * This is the ARIA select-only combobox. The trigger is a
 * `<button role="combobox">`, so a wrapping `<label>` still names it (a button
 * is labelable, and `getByLabelText` finds it). DOM focus stays on the trigger
 * the whole time the list is open; the keyboard cursor is
 * `aria-activedescendant`. That is what lets the list sit in a portal, outside
 * a modal dialog's DOM, without the dialog's focus trap noticing, and what
 * lets a pointer press on an option leave focus where it was.
 *
 * The list is portalled to `document.body` and placed `fixed` against the
 * trigger, for the reason `MessagingSurfacePicker` gives: Settings panels clip
 * with `overflow: hidden` and the Settings and Automations panes scroll, so a
 * list positioned inside the field would be cut off by the card it opens in.
 *
 * The closed field takes its chrome from the surface it sits in, through
 * `className` or a descendant rule (`.automation-field .select-trigger`).
 * This component draws only the value, the chevron and the popup.
 */

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** One muted line under the label, for a choice whose name does not explain it. */
  description?: string;
  /** Listed but not choosable. The arrows and typeahead step over it. */
  disabled?: boolean;
};

/** Gap between the trigger and the list. */
const LISTBOX_GAP = 4;
const VIEWPORT_PADDING = 12;
/** About ten rows. A taller list scrolls rather than covering the form. */
const LISTBOX_MAX_HEIGHT = 320;
/** How far PageUp and PageDown move the cursor. */
const PAGE_STEP = 10;
/**
 * A pause this long ends a typeahead run, so the next key starts a new
 * search. The APG listbox examples use the same interval.
 */
const TYPEAHEAD_RESET_MS = 500;

export type ListboxPlacement = {
  top: number;
  left: number;
  /** The trigger's width. The list is never narrower than its field. */
  minWidth: number;
  maxHeight: number;
  /** Opened above the trigger. */
  flipped: boolean;
};

/**
 * Place the list against the trigger in viewport coordinates.
 *
 * Below the trigger unless the list does not fit there and the space above is
 * larger, so a short list never flips just because its field sits low in the
 * window. A list that fits neither way takes the larger side and scrolls.
 * The left edge follows the trigger and is clamped so the list stays in the
 * window.
 */
export function placeListbox(input: {
  trigger: { top: number; bottom: number; left: number; width: number };
  /** The list's rendered width. */
  width: number;
  /** The list's full content height, border included. */
  contentHeight: number;
  viewport: {
    width: number;
    height: number;
    /** The highest y a portalled surface may use (`portalViewportTop`). */
    top: number;
  };
}): ListboxPlacement {
  const { trigger, viewport } = input;
  const floor = viewport.height - VIEWPORT_PADDING;
  const below = floor - trigger.bottom - LISTBOX_GAP;
  const above = trigger.top - LISTBOX_GAP - viewport.top;
  const wanted = Math.min(input.contentHeight, LISTBOX_MAX_HEIGHT);
  const flipped = wanted > below && above > below;
  const maxHeight = Math.max(
    0,
    Math.min(LISTBOX_MAX_HEIGHT, flipped ? above : below),
  );
  // A flipped list is pinned by its bottom edge, so its top depends on the
  // height it will actually render at.
  const top = flipped
    ? trigger.top - LISTBOX_GAP - Math.min(wanted, maxHeight)
    : trigger.bottom + LISTBOX_GAP;
  const width = Math.max(input.width, trigger.width);
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(trigger.left, viewport.width - VIEWPORT_PADDING - width),
  );
  return { top, left, minWidth: trigger.width, maxHeight, flipped };
}

function samePlacement(
  left: ListboxPlacement | null,
  right: ListboxPlacement,
): boolean {
  return (
    left !== null
    && left.top === right.top
    && left.left === right.left
    && left.minWidth === right.minWidth
    && left.maxHeight === right.maxHeight
    && left.flipped === right.flipped
  );
}

/**
 * The next choosable option after `from`, walking by `step`, or -1. Does not
 * wrap: the APG listbox stops at either end, and so does a native select.
 */
function stepChoosable(
  options: readonly SelectOption[],
  from: number,
  step: 1 | -1,
): number {
  for (let index = from + step; index >= 0 && index < options.length; index += step) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

/**
 * The option a typeahead run lands on, searching from `start`.
 *
 * A run of one repeated letter ("sss") steps through the options that begin
 * with it, as a native select does, so it searches from the option after the
 * cursor. Anything else is a prefix, and the cursor's own option still counts
 * as a match, so typing "sl" onto "Slack" leaves it there.
 */
export function matchTypeahead(
  options: readonly SelectOption[],
  query: string,
  start: number,
): number {
  const needle = query.toLocaleLowerCase();
  if (needle === "" || options.length === 0) return -1;
  const repeated = [...needle].every((char) => char === needle[0]);
  const prefix = repeated ? needle[0] : needle;
  const offset = repeated ? 1 : 0;
  for (let step = 0; step < options.length; step += 1) {
    const index =
      (((start + offset + step) % options.length) + options.length)
      % options.length;
    const option = options[index];
    if (!option.disabled && option.label.toLocaleLowerCase().startsWith(prefix)) {
      return index;
    }
  }
  return -1;
}

/**
 * The trigger's name when a wrapping or `for` label gives it, without the
 * trigger's own text, which a label's content includes when it wraps it.
 */
function labelText(control: HTMLButtonElement): string | undefined {
  const textOutside = (node: Node): string => {
    if (node === control) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    let text = "";
    for (const child of node.childNodes) text += textOutside(child);
    return text;
  };
  const text = [...(control.labels ?? [])]
    .map(textOutside)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? undefined : text;
}

export function Select<T extends string>(props: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** The closed field's chrome, from the surface it sits in. */
  className?: string;
  /**
   * Typography the list needs from the surface, such as a mono face for
   * model IDs. The list is portalled to `document.body`, so it cannot
   * inherit it from the field.
   */
  listboxClassName?: string;
  id?: string;
  disabled?: boolean;
  /** Trigger text while `value` matches no option. */
  placeholder?: string;
  ref?: Ref<HTMLButtonElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  const { options, value, onChange } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<ListboxPlacement | null>(null);
  const [listboxLabel, setListboxLabel] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ text: "", at: 0 });
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number): string => `${baseId}-option-${index}`;

  const forwardedRef = props.ref;
  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  // The cursor opens on the current value, as a native select's does, unless
  // that option cannot be chosen.
  const restingIndex =
    selected !== undefined && !selected.disabled
      ? selectedIndex
      : stepChoosable(options, -1, 1);
  // A list that shrank while open must not leave the cursor past its end.
  const cursor = active < options.length ? active : restingIndex;

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
    typeaheadRef.current = { text: "", at: 0 };
  }, []);

  const openAt = (index: number): void => {
    const trigger = triggerRef.current;
    setListboxLabel(
      props["aria-label"]
        ?? (trigger !== null ? labelText(trigger) : undefined),
    );
    setActive(index);
    setOpen(true);
  };

  const commit = (index: number): void => {
    const option = options[index];
    if (option === undefined || option.disabled) return;
    close();
    if (option.value !== value) onChange(option.value);
  };

  /** Folds `key` into the running search and returns the option it finds. */
  const typeahead = (key: string, from: number, now: number): number => {
    const run = typeaheadRef.current;
    const text =
      now - run.at > TYPEAHEAD_RESET_MS ? key : run.text + key;
    typeaheadRef.current = { text, at: now };
    return matchTypeahead(options, text, from);
  };

  const typing = (now: number): boolean =>
    typeaheadRef.current.text !== ""
    && now - typeaheadRef.current.at <= TYPEAHEAD_RESET_MS;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    // Escape is not handled here. The layer below claims it, so a list open
    // inside a dialog closes alone.
    if (props.disabled || event.metaKey || event.ctrlKey) return;
    const { key } = event;
    const now = Date.now();
    const printable = key.length === 1 && !event.altKey;

    if (!open) {
      let index: number | undefined;
      if (
        key === "ArrowDown"
        || key === "ArrowUp"
        || key === "Enter"
        || key === " "
      ) {
        index = restingIndex;
      } else if (key === "Home") {
        index = stepChoosable(options, -1, 1);
      } else if (key === "End") {
        index = stepChoosable(options, options.length, -1);
      } else if (printable) {
        // Opens on the match instead of choosing it, so a stray key on a
        // focused field never changes a value the operator cannot see.
        const match = typeahead(key, selectedIndex, now);
        index = match >= 0 ? match : restingIndex;
      }
      if (index === undefined) return;
      // Prevented so Enter and Space do not also click the button, which
      // would close the list again.
      event.preventDefault();
      event.stopPropagation();
      openAt(index);
      return;
    }

    let next: number | undefined;
    switch (key) {
      case "ArrowDown":
        next = stepChoosable(options, cursor, 1);
        break;
      case "ArrowUp":
        if (event.altKey) {
          event.preventDefault();
          commit(cursor);
          return;
        }
        next = stepChoosable(options, cursor, -1);
        break;
      case "Home":
        next = stepChoosable(options, -1, 1);
        break;
      case "End":
        next = stepChoosable(options, options.length, -1);
        break;
      case "PageDown":
      case "PageUp": {
        const step = key === "PageDown" ? 1 : -1;
        next = cursor;
        for (let moved = 0; moved < PAGE_STEP; moved += 1) {
          const candidate = stepChoosable(options, next, step);
          if (candidate < 0) break;
          next = candidate;
        }
        break;
      }
      case "Enter":
        event.preventDefault();
        event.stopPropagation();
        commit(cursor);
        return;
      case "Tab":
        // Closes without choosing. The APG pattern commits on Tab, but that
        // turns "arrowed past it on the way out" into a changed value.
        close();
        return;
      default:
        if (key === " " && !typing(now)) {
          event.preventDefault();
          event.stopPropagation();
          commit(cursor);
          return;
        }
        if (printable) {
          next = typeahead(key, cursor, now);
        }
    }
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (next >= 0) setActive(next);
  };

  useDismissableLayer({
    open,
    onDismiss: close,
    surfaceRef: listboxRef,
    triggerRef,
  });

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const listbox = listboxRef.current;
    if (trigger === null || listbox === null) return;
    const rect = trigger.getBoundingClientRect();
    // A trigger scrolled out of the window takes its list with it, rather
    // than leaving it floating over whatever scrolled in. Strict, so a box
    // with no layout (all zeros) is not mistaken for one above the window.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      close();
      return;
    }
    const next = placeListbox({
      trigger: rect,
      width: listbox.offsetWidth,
      contentHeight:
        listbox.scrollHeight + listbox.offsetHeight - listbox.clientHeight,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        top: portalViewportTop(),
      },
    });
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [close]);

  // Before paint, so the list never shows unplaced. The first pass renders it
  // hidden at the origin to measure it. Every render while open, not just the
  // opening one: relabelled options change the height a flipped list is
  // pinned by, and a new `minWidth` changes the width the left clamp used.
  // `samePlacement` stops it once the measurement settles.
  useLayoutEffect(() => {
    if (open) place();
  });

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    // One reposition per frame: momentum scrolling fires many events a frame.
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const handleScroll = (event: Event): void => {
      // The list scrolling its own rows moves nothing.
      if (listboxRef.current?.contains(event.target as Node)) return;
      schedule();
    };
    // Capture: the trigger sits in a scrolling pane, and a pane's scroll
    // event does not bubble to window.
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", schedule);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    // Capture, so a surface that stops the press on its way up (the Star Map
    // canvas does) cannot keep the list open.
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      const trigger = triggerRef.current;
      // A press on the field's own label is a press on the field: the label
      // forwards its click to the trigger, which toggles the list. Closing
      // here first would turn that click into a reopen.
      if (
        trigger?.contains(target)
        || [...(trigger?.labels ?? [])].some((label) => label.contains(target))
        || listboxRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open || placement === null || cursor < 0) return;
    // `nearest` scrolls only the list: it is `fixed` inside the window, so no
    // ancestor has anything to add. The options' `scroll-margin` keeps the
    // list's padding in view at either end.
    document
      .getElementById(`${baseId}-option-${cursor}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, placement, cursor, baseId]);

  // Chromium fires no blur when a focused button is disabled under it.
  useEffect(() => {
    if (props.disabled) close();
  }, [close, props.disabled]);

  const listbox = open
    ? createPortal(
      <div
        ref={listboxRef}
        id={listboxId}
        role="listbox"
        // Never a Tab stop. Chromium makes an overflowing scroller with
        // nothing focusable in it one unless it says otherwise, and focus
        // belongs on the trigger.
        tabIndex={-1}
        aria-label={props["aria-labelledby"] === undefined ? listboxLabel : undefined}
        aria-labelledby={props["aria-labelledby"]}
        className={["select-listbox", props.listboxClassName]
          .filter(Boolean)
          .join(" ")}
        style={
          placement === null
            ? { top: 0, left: 0, visibility: "hidden" }
            : {
              top: placement.top,
              left: placement.left,
              minWidth: placement.minWidth,
              maxHeight: placement.maxHeight,
            }
        }
        // React bubbles a portal's events through the component tree, not
        // the DOM, so a press or a wheel in the list would otherwise reach
        // whatever the field sits in: a card that pans on a press, a row
        // that opens on a click.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        // A press anywhere in the list, its scrollbar included, must not
        // take focus from the trigger either: the trigger's blur closes the
        // list, and inside a dialog the trap would pull focus back anyway.
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          const descriptionId = option.description
            ? `${optionId(index)}-description`
            : undefined;
          return (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={isSelected}
              aria-disabled={option.disabled ? true : undefined}
              aria-describedby={descriptionId}
              className={index === cursor ? "select-option is-active" : "select-option"}
              // The pointer moves the keyboard cursor, so a hovered row and
              // the row Enter picks are never two rows in the same paint.
              // `pointermove`, not `pointerenter`: a list scrolled under a
              // resting pointer must not steal the cursor from the arrows.
              onPointerMove={() => {
                if (!option.disabled && index !== cursor) setActive(index);
              }}
              onClick={() => commit(index)}
            >
              <span aria-hidden="true" className="select-option__check">
                {isSelected ? <CheckIcon size={12} /> : null}
              </span>
              <span className="select-option__body">
                <span className="select-option__label">{option.label}</span>
                {option.description ? (
                  // Hidden from the option's name, which is its label alone;
                  // `aria-describedby` still reaches it.
                  <span
                    aria-hidden="true"
                    className="select-option__description"
                    id={descriptionId}
                  >
                    {option.description}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={setTriggerRef}
        type="button"
        role="combobox"
        id={props.id}
        className={["select-trigger", props.className].filter(Boolean).join(" ")}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && cursor >= 0 ? optionId(cursor) : undefined}
        data-value={value}
        disabled={props.disabled}
        onBlur={(event) => {
          if (open && !listboxRef.current?.contains(event.relatedTarget as Node)) {
            close();
          }
        }}
        // A press, a wrapping label's click, and a screen reader's activation
        // all arrive here. Enter and Space are handled on keydown.
        onClick={() => {
          if (open) close();
          else openAt(restingIndex);
        }}
        onKeyDown={handleKeyDown}
      >
        <span
          className={
            selected === undefined
              ? "select-trigger__value select-trigger__value--placeholder"
              : "select-trigger__value"
          }
        >
          {selected?.label ?? props.placeholder ?? ""}
        </span>
        <span aria-hidden="true" className="select-trigger__chevron" />
      </button>
      {listbox}
    </>
  );
}
