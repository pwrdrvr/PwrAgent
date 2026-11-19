import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  type IconProps,
} from "../../icons";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import { placeTodoModelMenu } from "./todo-model-menu-placement";

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
  disabled?: boolean;
  /** Names the chevron, e.g. "Merge options". */
  menuLabel: string;
  entries: TodoSplitMenuEntry[];
};

/**
 * A card's action as the composer's Send pill: the chevron opens the
 * alternatives and the label runs the default. The menu swaps a submenu in
 * place rather than flying out, since a card sits against the transcript's
 * right edge with nowhere to fly to.
 *
 * The menu is a portal on the body, placed against the window: inside the
 * To-dos rail its scroller would clip it and the sticky group headings would
 * paint over it. It opens below the pill when it fits and above otherwise,
 * so a toast on the window's bottom edge opens it upward.
 */
export function TodoSplitButton(props: TodoSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const [submenuId, setSubmenuId] = useState<string>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number }>();
  const close = (): void => {
    setOpen(false);
    setSubmenuId(undefined);
    // The next open measures again before it shows.
    setPosition(undefined);
  };

  // The menu measures itself hidden before it is placed; it can take focus
  // only once it is visible.
  const placed = open && position !== undefined;
  useMenuNavigation({ open: placed, menuRef, triggerRef, onClose: close });

  // The keyboard hook leaves the pointer to the menu: any press outside
  // the pill closes it.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!wrapperRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        close();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  // Right edges line up, as the menu hung under the pill before it floated.
  const place = useCallback(() => {
    const pill = wrapperRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!pill || !menu) return;
    const menuWidth = menu.offsetWidth;
    const next = placeTodoModelMenu({
      trigger: { left: pill.right - menuWidth, top: pill.top, bottom: pill.bottom },
      menuHeight: menu.scrollHeight + menu.offsetHeight - menu.clientHeight,
      menuWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    });
    setPosition((current) => current?.left === next.left && current.top === next.top
      && current.maxHeight === next.maxHeight ? current : next);
  }, []);
  // A submenu swap can change the menu's size.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, submenuId, place]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // A swapped list starts on its first row, as a freshly opened menu does.
  useLayoutEffect(() => {
    if (!placed) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"],[role="menuitemradio"]')
      ?.focus();
  }, [placed, submenuId]);

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
        <button type="button" className="todo-split__primary" disabled={props.disabled} onClick={props.onClick}>
          {PrimaryIcon ? <PrimaryIcon size={12} /> : null}
          {props.label}
        </button>
      </div>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="todo-split__menu todo-split__menu--floating"
          style={position ?? { visibility: "hidden" }}
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
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
