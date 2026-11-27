import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon, MoreHorizontalIcon } from "../../../icons";
import { useMenuNavigation } from "../../../lib/useMenuNavigation";
import {
  useCloseOnOutsidePointer,
  useTodoFactMenuPlacement,
} from "../../thread-todos/TodoFactMenu";

export type DetailsRowMenuEntry =
  | {
      kind: "item";
      key: string;
      label: string;
      /** Shown after the label, dimmer: a path, an id, a time. */
      detail?: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | { kind: "heading"; key: string; label: string }
  | { kind: "separator"; key: string };

/**
 * A Details row's ⋯ menu: the actions that belong to the row but do not earn
 * a button of their own. It is portaled, so `onOpenChange` lets an unpinned
 * rail stay open while the pointer is over it.
 */
export function DetailsRowMenu(props: {
  /** The menu's name, which the ⋯ button carries too. */
  label: string;
  entries: readonly DetailsRowMenuEntry[];
  onOpenChange?: (open: boolean) => void;
  /** A chevron for the second half of a split row; ⋯ otherwise. */
  trigger?: "more" | "chevron";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const { onOpenChange } = props;
  const close = useCallback(() => setOpen(false), []);
  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });
  useCloseOnOutsidePointer({ open, triggerRef, menuRef, onClose: close });
  const position = useTodoFactMenuPlacement({ open, triggerRef, menuRef, width: 280 });
  useEffect(() => {
    if (!open) return undefined;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);
  if (props.entries.length === 0) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`details-row__more${props.trigger === "chevron" ? " details-row__more--chevron" : ""}`}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {props.trigger === "chevron"
          ? <ChevronDownIcon size={12} aria-hidden="true" />
          : <MoreHorizontalIcon size={14} aria-hidden="true" />}
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={id}
          className="todo-split__menu details-row-menu"
          style={position}
          role="menu"
          aria-label={props.label}
          tabIndex={-1}
        >
          {props.entries.map((entry) => {
            if (entry.kind === "separator") {
              return <div key={entry.key} className="todo-split__separator" role="separator" />;
            }
            if (entry.kind === "heading") {
              return (
                <p key={entry.key} className="details-row-menu__heading" role="presentation">
                  {entry.label}
                </p>
              );
            }
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={`todo-split__item details-row-menu__item${
                  entry.danger ? " details-row-menu__item--danger" : ""
                }`}
                aria-disabled={entry.disabled ? true : undefined}
                onClick={() => {
                  if (entry.disabled) return;
                  close();
                  entry.onSelect();
                }}
              >
                <span className="todo-split__item-label">{entry.label}</span>
                {entry.detail ? (
                  <span className="details-row-menu__detail">{entry.detail}</span>
                ) : null}
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
