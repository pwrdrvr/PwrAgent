import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { getDesktopApi } from "../../lib/desktop-api";
import type { AppMenuTopLevel } from "../../../../shared/app-menu";

/**
 * The painted application menu bar (File / Edit / View / Profiles / Window /
 * Help), rendered inside the Windows title strip by `AppTitleBar`.
 *
 * Under `titleBarStyle: "hidden"` the native Windows menu bar is gone — the
 * menu lived in the title bar we hid. So we paint the top-level entries as
 * buttons and, on click or Alt-mnemonic, ask main to pop the REAL native
 * submenu at the button (`popupAppMenu`). Roles, accelerators, dynamic
 * enable/disable, and click handlers all live in the application menu main
 * already builds — this component owns only the bar's looks + keyboard entry.
 *
 * Renders the `<nav>` only (no strip chrome — `AppTitleBar` owns that) and
 * nothing until the model loads. `AppTitleBar` gates on win32, so this is only
 * ever mounted there.
 */
export function AppMenuBar(): ReactElement | null {
  const [items, setItems] = useState<AppMenuTopLevel[]>([]);
  // Array position (not menu index) of the keyboard-focused entry, or null.
  const [focusedPos, setFocusedPos] = useState<number | null>(null);
  const btnRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    const api = getDesktopApi();
    if (api?.getAppMenuModel === undefined) return;
    let alive = true;
    void api.getAppMenuModel().then((model) => {
      if (alive) setItems(Array.isArray(model) ? model : []);
    });
    return () => {
      alive = false;
    };
  }, []);

  const openMenu = useCallback((index: number): void => {
    const btn = btnRefs.current.get(index);
    const api = getDesktopApi();
    if (btn === undefined || api?.popupAppMenu === undefined) return;
    const rect = btn.getBoundingClientRect();
    // Window-relative bottom-left of the button → native submenu anchors there.
    api.popupAppMenu({
      index,
      x: Math.round(rect.left),
      y: Math.round(rect.bottom),
    });
    setFocusedPos(null);
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Plain Alt: toggle the keyboard-focus highlight on the bar (Windows
      // convention — Alt then arrows/Enter, or Alt+<letter> below).
      if (event.key === "Alt") {
        event.preventDefault();
        setFocusedPos((cur) => (cur === null ? 0 : null));
        return;
      }
      // Alt + first-letter mnemonic (e.g. Alt+F → File). Alt is held, so this
      // never collides with typing in an input.
      if (event.altKey && event.key.length === 1) {
        const ch = event.key.toLowerCase();
        const match = items.find((it) => it.label.toLowerCase().startsWith(ch));
        if (match !== undefined) {
          event.preventDefault();
          openMenu(match.index);
        }
        return;
      }
      // Bar-focused navigation (after a plain Alt).
      if (focusedPos === null) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setFocusedPos((cur) => ((cur ?? -1) + 1) % items.length);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFocusedPos((cur) => ((cur ?? 0) - 1 + items.length) % items.length);
      } else if (
        event.key === "Enter" ||
        event.key === "ArrowDown" ||
        event.key === " "
      ) {
        event.preventDefault();
        const it = items[focusedPos];
        if (it !== undefined) openMenu(it.index);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setFocusedPos(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, focusedPos, openMenu]);

  if (items.length === 0) return null;
  return (
    <nav className="app-titlebar__menubar" aria-label="Application menu">
      {items.map((it, pos) => (
        <button
          key={it.index}
          type="button"
          ref={(el) => {
            if (el === null) btnRefs.current.delete(it.index);
            else btnRefs.current.set(it.index, el);
          }}
          className={
            "app-titlebar__menu-item" +
            (focusedPos === pos ? " is-focused" : "")
          }
          onClick={() => openMenu(it.index)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}
