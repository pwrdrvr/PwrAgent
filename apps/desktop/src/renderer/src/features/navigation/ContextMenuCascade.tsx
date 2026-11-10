import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** Keeps the flyout this far inside the window when it has to move. */
const VIEWPORT_MARGIN = 8;

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function isEnabled(item: HTMLElement): boolean {
  return item.getAttribute("aria-disabled") !== "true";
}

/**
 * A context-menu row that cascades a second menu to its right.
 *
 * Hover, or ArrowRight, opens the flyout; ArrowLeft returns to the row. The
 * row keeps its own click when `onSelect` is given; without one, a click
 * opens the flyout and focuses its first enabled item. The flyout moves to
 * the row's left, or up, when it would cross the window edge.
 */
export function ContextMenuCascade(props: {
  label: ReactNode;
  /** The flyout's heading. */
  groupLabel: string;
  /**
   * Only the row's own click waits; the flyout stays reachable, by pointer
   * and by keyboard.
   */
  rowDisabled?: boolean;
  /** The row's own click. Without it, a click opens the flyout. */
  onSelect?: () => void;
  /** Reports the flyout opening, so its rows can load only when seen. */
  onOpenChange?: (open: boolean) => void;
  /** The flyout's `role="menuitem"` rows, and any separators. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [focusFirst, setFocusFirst] = useState(false);
  // Where the flyout sits when the default (right of the row, top-aligned)
  // would cross the window edge.
  const [startSide, setStartSide] = useState(false);
  const [shiftY, setShiftY] = useState(0);
  const cascadeRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();
  const groupLabelId = useId();
  const { onOpenChange } = props;

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  // Measured on every render while open: a row that grows (a machine
  // resolving from "Checking…" to a branch line) grows the flyout. The
  // inputs are the row's box and the flyout's own size, never its placed
  // position, so a render that only moves the flyout measures the same and
  // React bails out.
  useLayoutEffect(() => {
    const cascade = cascadeRef.current;
    const flyout = flyoutRef.current;
    if (!open || !cascade || !flyout) {
      return;
    }
    const row = cascade.getBoundingClientRect();
    const width = flyout.offsetWidth;
    const height = flyout.offsetHeight;
    const fitsEnd = row.right + 2 + width <= window.innerWidth - VIEWPORT_MARGIN;
    const fitsStart = row.left - 2 - width >= VIEWPORT_MARGIN;
    setStartSide(!fitsEnd && fitsStart);
    const top = row.top - 4;
    const overflow = top + height - (window.innerHeight - VIEWPORT_MARGIN);
    setShiftY(overflow > 0 ? -Math.min(overflow, top - VIEWPORT_MARGIN) : 0);
  });

  useEffect(() => {
    if (open && focusFirst) {
      const items = menuItems(flyoutRef.current);
      (items.find(isEnabled) ?? items[0])?.focus();
      setFocusFirst(false);
    }
  }, [focusFirst, open]);

  const closeToRow = (): void => {
    setOpen(false);
    rowRef.current?.focus();
  };

  const openAndFocus = (): void => {
    setOpen(true);
    setFocusFirst(true);
  };

  const handleFlyoutKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Claimed here so the outer menu's key walk, which skips a prevented
    // key, stays out of the flyout. Home and End too: the outer walk counts
    // these rows as its own and would carry focus out of an open flyout.
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      closeToRow();
      return;
    }
    if (
      event.key !== "ArrowDown"
      && event.key !== "ArrowUp"
      && event.key !== "Home"
      && event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    // Every row, disabled ones included: a disabled row's reason is only
    // heard when focus can land on it.
    const items = menuItems(flyoutRef.current);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? items[0]
        : event.key === "End"
          ? items[items.length - 1]
          : event.key === "ArrowDown"
            ? items[(at + 1) % items.length]
            : items[at <= 0 ? items.length - 1 : at - 1];
    next?.focus();
  };

  return (
    <div
      ref={cascadeRef}
      className="thread-context-menu__cascade"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        // Keep the keyboard inside the menu when the pointer wanders off
        // while focus is in the flyout: unmounting it would drop focus to
        // <body>, where the outer menu no longer hears its keys.
        if (flyoutRef.current?.contains(document.activeElement)) {
          closeToRow();
          return;
        }
        setOpen(false);
      }}
    >
      <button
        ref={rowRef}
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? flyoutId : undefined}
        aria-disabled={props.rowDisabled || undefined}
        onClick={() => {
          if (!props.onSelect) {
            openAndFocus();
          } else if (!props.rowDisabled) {
            props.onSelect();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            openAndFocus();
          }
        }}
      >
        {props.label}
        <span aria-hidden="true" className="thread-context-menu__cascade-chevron">
          ›
        </span>
      </button>
      {open ? (
        <div
          ref={flyoutRef}
          id={flyoutId}
          className={startSide
            ? "thread-context-menu thread-context-menu__flyout thread-context-menu__flyout--start"
            : "thread-context-menu thread-context-menu__flyout"}
          style={shiftY !== 0 ? { top: -4 + shiftY } : undefined}
          role="menu"
          aria-labelledby={groupLabelId}
          onKeyDown={handleFlyoutKeyDown}
        >
          <div role="group" aria-labelledby={groupLabelId}>
            <div className="new-thread-menu__section-label" id={groupLabelId}>
              {props.groupLabel}
            </div>
            {props.children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
