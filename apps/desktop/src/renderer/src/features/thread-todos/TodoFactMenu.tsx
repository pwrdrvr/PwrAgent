import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "../../icons";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { placeTodoModelMenu } from "./todo-model-menu-placement";

/**
 * Keeps a fact chip's popover beside its chip: under it, aligned with the
 * card's facts, flipped up when the window has no room below. It follows
 * the chip as the card scrolls or resizes, and as its own content grows.
 */
export function useTodoFactMenuPlacement(params: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
  width: number;
}): { left: number; top: number; maxHeight?: number } {
  const { open, triggerRef, menuRef, width } = params;
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight?: number }>({ left: 0, top: 0 });
  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const facts = triggerRef.current?.closest(".thread-todo-card__facts")?.getBoundingClientRect();
    const next = placeTodoModelMenu({
      trigger,
      alignLeft: facts?.left,
      menuHeight: menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
      menuWidth: menu.offsetWidth || width,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    });
    setPosition((current) => current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight
      ? current : next);
  }, [menuRef, triggerRef, width]);
  useLayoutEffect(() => { if (open) place(); });
  useLayoutEffect(() => {
    if (!open) return;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, triggerRef, menuRef]);
  return position;
}

/** Closes a popover on a pointer press outside it and its chip. */
export function useCloseOnOutsidePointer(params: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  menuRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  const { open, triggerRef, menuRef, onClose } = params;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, triggerRef, menuRef, onClose]);
}

export type TodoFactMenuEntry =
  | {
      kind: "item";
      key: string;
      label: string;
      /** A short note after the label: why it is the default, or why it is off. */
      detail?: string;
      checked: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator"; key: string }
  | { kind: "note"; key: string; text: string };

/**
 * One editable fact on a start-thread card: a chip that names the value the
 * start will use, and a menu of the alternatives. The chip carries an accent
 * border while the value differs from the card's default.
 */
export function TodoFactMenu(props: {
  /** The menu's name, and the chip's: "Machine for the new thread". */
  label: string;
  value: string;
  entries: TodoFactMenuEntry[];
  changed?: boolean;
  disabled?: boolean;
  /** Shown on the chip when it is disabled or at rest. */
  tooltip?: string;
  footnote?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });
  useCloseOnOutsidePointer({ open, triggerRef, menuRef, onClose: close });
  const position = useTodoFactMenuPlacement({ open, triggerRef, menuRef, width: 260 });
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled}
        className={`composer-dropdown__button todo-model-picker__chip${props.tooltip ? " tooltip-target" : ""}${props.changed ? " is-changed" : ""}`}
        aria-label={`${props.label}: ${props.value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-tooltip={open ? undefined : props.tooltip}
        data-testid={props.testId}
        onClick={() => setOpen(!open)}
      >
        <span className="composer-dropdown__label">{props.value}</span>
        <span className="composer-dropdown__icon" aria-hidden="true"><ChevronDownIcon size={12} /></span>
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={id}
          className="todo-split__menu todo-model-picker__menu todo-fact-menu"
          style={position}
          role="menu"
          aria-label={props.label}
          tabIndex={-1}
        >
          {props.entries.map((entry) => {
            if (entry.kind === "separator") return <div key={entry.key} className="todo-split__separator" role="separator" />;
            if (entry.kind === "note") return <p key={entry.key} className="todo-model-picker__error" role="presentation">{entry.text}</p>;
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitemradio"
                className="todo-split__item"
                aria-checked={entry.checked}
                aria-disabled={entry.disabled ? true : undefined}
                onClick={() => {
                  if (entry.disabled) return;
                  entry.onSelect();
                  close();
                }}
              >
                <span className="todo-split__item-check" aria-hidden="true">
                  {entry.checked ? <CheckIcon size={12} /> : null}
                </span>
                <span className="todo-split__item-label">{entry.label}</span>
                {entry.detail ? <span className="todo-model-picker__detail">{entry.detail}</span> : null}
              </button>
            );
          })}
          {props.footnote ? <p className="todo-model-picker__footnote">{props.footnote}</p> : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
