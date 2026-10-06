import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  type IconProps,
} from "../../icons";
import { useMenuNavigation } from "../../lib/useMenuNavigation";

export type TodoSplitMenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      /** A radio pick, such as a merge method. Absent for a plain command. */
      checked?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      /** Opens a second list in place, with a Back row. One level deep. */
      kind: "submenu";
      id: string;
      label: string;
      entries: TodoSplitMenuEntry[];
    }
  | { kind: "separator"; id: string };

export type TodoSplitButtonProps = {
  label: string;
  Icon?: ComponentType<IconProps>;
  onClick: () => void;
  /** Names the chevron, e.g. "Merge options". */
  menuLabel: string;
  entries: TodoSplitMenuEntry[];
};

/**
 * A card's action as the composer's Send pill: the chevron opens the
 * alternatives and the label runs the default. The menu swaps a submenu in
 * place rather than flying out, since a card sits against the transcript's
 * right edge with nowhere to fly to.
 */
export function TodoSplitButton(props: TodoSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const [submenuId, setSubmenuId] = useState<string>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (): void => {
    setOpen(false);
    setSubmenuId(undefined);
  };

  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });

  // The keyboard hook leaves the pointer to the menu: any press outside
  // the pill closes it.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  // A swapped list starts on its first row, as a freshly opened menu does.
  useLayoutEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"],[role="menuitemradio"]')
      ?.focus();
  }, [open, submenuId]);

  const submenu = submenuId
    ? props.entries.find(
        (entry): entry is Extract<TodoSplitMenuEntry, { kind: "submenu" }> =>
          entry.kind === "submenu" && entry.id === submenuId,
      )
    : undefined;
  const entries = submenu ? submenu.entries : props.entries;
  const PrimaryIcon = props.Icon;

  return (
    <div
      ref={wrapperRef}
      className={`todo-split${open ? " todo-split--open" : ""}`}
    >
      <div className="todo-split__pill">
        <button
          ref={triggerRef}
          type="button"
          className="todo-split__chevron"
          aria-label={props.menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <ChevronDownIcon size={12} />
        </button>
        <button type="button" className="todo-split__primary" onClick={props.onClick}>
          {PrimaryIcon ? <PrimaryIcon size={12} /> : null}
          {props.label}
        </button>
      </div>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          className="todo-split__menu"
          role="menu"
          aria-label={submenu ? submenu.label : props.menuLabel}
          tabIndex={-1}
        >
          {submenu ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="todo-split__item todo-split__item--back"
                onClick={() => setSubmenuId(undefined)}
              >
                <span className="todo-split__item-check" aria-hidden="true">
                  <ChevronLeftIcon size={12} />
                </span>
                <span className="todo-split__item-label">{submenu.label}</span>
              </button>
              <div className="todo-split__separator" role="separator" />
            </>
          ) : null}
          {entries.map((entry) => {
            if (entry.kind === "separator") {
              return <div key={entry.id} className="todo-split__separator" role="separator" />;
            }
            if (entry.kind === "submenu") {
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  className="todo-split__item"
                  onClick={() => setSubmenuId(entry.id)}
                >
                  <span className="todo-split__item-check" aria-hidden="true" />
                  <span className="todo-split__item-label">{entry.label}</span>
                  <ChevronRightIcon size={12} />
                </button>
              );
            }
            const radio = entry.checked !== undefined;
            return (
              <button
                key={entry.id}
                type="button"
                role={radio ? "menuitemradio" : "menuitem"}
                aria-checked={radio ? entry.checked : undefined}
                aria-disabled={entry.disabled || undefined}
                className="todo-split__item"
                onClick={() => {
                  if (entry.disabled) return;
                  close();
                  entry.onSelect();
                }}
              >
                <span className="todo-split__item-check" aria-hidden="true">
                  {entry.checked ? <CheckIcon size={12} /> : null}
                </span>
                <span className="todo-split__item-label">{entry.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
