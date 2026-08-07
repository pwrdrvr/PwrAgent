import { useCallback, useEffect, useRef, useState } from "react";

export type StarMapCardMenuAction = {
  /** Destructive entries are tinted and separated from the rest. */
  danger?: boolean;
  disabled?: boolean;
  key: string;
  label: string;
  onSelect: () => void;
};

/**
 * Per-card kebab on the star map.
 *
 * Lives beside the card's clickable surface rather than inside it: the
 * surface is a `<button>`, and a button inside a button is neither valid
 * nor operable. The shell wrapper exists for exactly this reason.
 */
export function StarMapCardMenu(props: {
  actions: StarMapCardMenuAction[];
  threadTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The shell starts a card drag on pointerdown; without this a press on
  // the kebab would drag the card out from under the pointer.
  const swallow = useCallback((event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  }, []);

  return (
    <div className="star-map-card__menu" ref={rootRef} onPointerDown={swallow}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${props.threadTitle}`}
        className="star-map-card__menu-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        ⋯
      </button>
      {open ? (
        <div className="star-map-card__menu-list" role="menu">
          {props.actions.map((action) => (
            <button
              className={`star-map-card__menu-item${
                action.danger ? " star-map-card__menu-item--danger" : ""
              }`}
              disabled={action.disabled}
              key={action.key}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              role="menuitem"
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
