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
 * Windows-only custom application menu bar, painted into our frameless title
 * strip.
 *
 * Under `titleBarStyle: "hidden"` (our custom chrome) the native Windows menu
 * bar is gone — the menu lived in the title bar we hid. So we paint the
 * top-level entries (File / View / Profiles / Window / Help) as buttons and, on
 * click or Alt-mnemonic, ask main to pop the REAL native submenu at the button
 * (`popupAppMenu`). Roles, accelerators, dynamic enable/disable, and click
 * handlers all live in the application menu main already builds — this
 * component owns only the bar's looks + keyboard entry.
 *
 * Renders nothing off win32. The strip (drag region) renders on win32 even
 * before the model loads so the window stays draggable and the content offset
 * (`--win-titlebar-h`) is consistent.
 */
export function AppMenuBar(): ReactElement | null {
  const isWindows = getDesktopApi()?.platform === "win32";
  const [items, setItems] = useState<AppMenuTopLevel[]>([]);
  // Array position (not menu index) of the keyboard-focused entry, or null.
  const [focusedPos, setFocusedPos] = useState<number | null>(null);
  const btnRefs = useRef(new Map<number, HTMLButtonElement>());

  useEffect(() => {
    if (!isWindows) return;
    const api = getDesktopApi();
    if (api?.getAppMenuModel === undefined) return;
    let alive = true;
    void api.getAppMenuModel().then((model) => {
      if (alive) setItems(Array.isArray(model) ? model : []);
    });
    return () => {
      alive = false;
    };
  }, [isWindows]);

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
    if (!isWindows || items.length === 0) return;
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
  }, [isWindows, items, focusedPos, openMenu]);

  if (!isWindows) return null;
  return (
    <div className="app-titlebar">
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
    </div>
  );
}
