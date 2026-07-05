import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type FocusEvent as ReactFocusEvent,
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

  // Load the top-level model on mount AND whenever this window regains focus.
  // The native application menu is rebuilt in main on profile switches,
  // dev-mode menu rebuilds, and Window-menu refreshes; re-reading on focus
  // keeps the painted bar's labels/visibility in sync without a dedicated
  // change event. (The popup path always reads the live submenu, so only the
  // top-level entries can go stale.) A single `cancelled` flag guards every
  // in-flight fetch — the initial one and each focus-triggered refresh.
  useEffect(() => {
    const api = getDesktopApi();
    if (api?.getAppMenuModel === undefined) return;
    let cancelled = false;
    const load = (): void => {
      void api.getAppMenuModel?.().then((model) => {
        if (!cancelled) setItems(Array.isArray(model) ? model : []);
      });
    };
    load();
    const onFocus = (): void => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Move real DOM focus to the active entry so screen readers announce it and
  // the OS focus ring tracks keyboard navigation. Never steals focus on mount
  // (focusedPos starts null); only runs once a position is active.
  useEffect(() => {
    if (focusedPos === null) return;
    const it = items[focusedPos];
    if (it !== undefined) btnRefs.current.get(it.index)?.focus();
  }, [focusedPos, items]);

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

  // Global: Alt enters the bar; Alt+<letter> opens by mnemonic. These must be
  // global because focus isn't on the bar yet. In-bar navigation (arrows,
  // Enter/Space, Escape) is handled on the <nav> once it actually holds focus.
  useEffect(() => {
    if (items.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Plain Alt: toggle the keyboard-focus highlight on the bar (Windows
      // convention — Alt then arrows/Enter, or Alt+<letter> below). Ignore
      // auto-repeat so holding Alt doesn't flicker the highlight on/off.
      if (event.key === "Alt") {
        if (event.repeat) return;
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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, openMenu]);

  // In-bar navigation, handled only while the menubar actually holds focus.
  // Enter/Space fall through to the native button activation (onClick) so the
  // submenu isn't popped twice; we own arrows + Escape (and ArrowDown-to-open).
  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (items.length === 0) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setFocusedPos((cur) => ((cur ?? -1) + 1) % items.length);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setFocusedPos((cur) => ((cur ?? 0) - 1 + items.length) % items.length);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const it = focusedPos !== null ? items[focusedPos] : undefined;
        if (it !== undefined) openMenu(it.index);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setFocusedPos(null);
        // Return focus out of the bar so the highlight + focus ring both clear.
        if (event.target instanceof HTMLElement) event.target.blur();
      }
    },
    [items, focusedPos, openMenu],
  );

  // Clear the keyboard-focus state when focus leaves the bar entirely (click
  // elsewhere, Tab away) so the highlight never sticks. Moving focus between
  // two entries keeps relatedTarget inside the <nav>, so navigation doesn't
  // trip this.
  const onMenuBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>): void => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setFocusedPos(null);
      }
    },
    [],
  );

  if (items.length === 0) return null;
  return (
    <nav
      className="app-titlebar__menubar"
      aria-label="Application menu"
      role="menubar"
      onKeyDown={onMenuKeyDown}
      onBlur={onMenuBlur}
    >
      {items.map((it, pos) => (
        <button
          key={it.index}
          type="button"
          role="menuitem"
          aria-haspopup="true"
          // Roving tabindex: the active entry is the bar's single tab stop;
          // when nothing is active the bar stays out of the Tab order (Windows
          // menu bars are reached via Alt, not Tab).
          tabIndex={focusedPos === pos ? 0 : -1}
          ref={(el) => {
            if (el === null) btnRefs.current.delete(it.index);
            else btnRefs.current.set(it.index, el);
          }}
          className={
            "app-titlebar__menu-item"
            + (focusedPos === pos ? " is-focused" : "")
          }
          onClick={() => openMenu(it.index)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}
