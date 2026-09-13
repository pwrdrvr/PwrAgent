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
 * Help), rendered inside the painted title strip by `AppTitleBar`.
 *
 * Under `titleBarStyle: "hidden"` the native menu bar is gone on both
 * platforms that use it, for two different reasons. On Windows the menu lived
 * in the title bar we hid. On Linux `titleBarStyle: "hidden"` IS `frame:
 * false`, and Electron's `RootView::SetMenu` returns before constructing a
 * menu bar for a window with no frame — it registers that menu's accelerators
 * BEFORE the early return, so Ctrl+N and Ctrl+, still work with no bar to hang
 * them on, but nothing is drawn.
 *
 * So we paint the top-level entries as buttons and, on click or Alt-mnemonic,
 * ask main to pop the REAL native submenu at the button (`popupAppMenu`).
 * Roles, accelerators, dynamic enable/disable, and click handlers all live in
 * the application menu main already builds — this component owns only the
 * bar's looks + keyboard entry.
 *
 * Renders the `<nav>` only (no strip chrome — `AppTitleBar` owns that) and
 * nothing until the model loads. `AppTitleBar` gates on `paintsAppTitleBar`,
 * so this is only ever mounted where the native bar is gone.
 */
export function AppMenuBar(): ReactElement | null {
  const [items, setItems] = useState<AppMenuTopLevel[]>([]);
  // Array position (not menu index) of the keyboard-focused entry, or null.
  const [focusedPos, setFocusedPos] = useState<number | null>(null);
  const btnRefs = useRef(new Map<number, HTMLButtonElement>());
  // Where focus was when the bar was entered FROM THE KEYBOARD, so leaving it
  // puts the caret back. Firefox does exactly this on Linux: Alt reveals the
  // bar and takes focus, Alt again hides it and returns the caret to the page
  // where it was. Null after a mouse click on an entry — there is nothing to
  // restore then, and the click already moved focus deliberately.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The global Alt handler below is subscribed once per menu model, not per
  // keystroke, so it cannot close over `focusedPos` — it would read whatever
  // the value was when the listener was attached. This mirror is what "am I
  // already in the bar?" asks at key-up time.
  const focusedPosRef = useRef<number | null>(null);
  focusedPosRef.current = focusedPos;

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

  /** Take keyboard focus into the bar, remembering where it came from. */
  const enterBar = useCallback((): void => {
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setFocusedPos(0);
  }, []);

  /**
   * Leave the bar and put focus back where it came from.
   *
   * Clearing `focusedPos` alone is not leaving: it drops the `is-focused`
   * class but the entry keeps real DOM focus, so the button stays lit and the
   * composer never gets the caret back. That is the "press Alt twice and File
   * just flickers, then you have to press Escape, and the composer is dead"
   * report. Blur what we focused, then restore.
   */
  const exitBar = useCallback((): void => {
    setFocusedPos(null);
    const active = document.activeElement;
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (active instanceof HTMLElement && active.closest(".app-titlebar__menubar")) {
      active.blur();
    }
    // `isConnected`, not a truthiness check: the surface that had focus can be
    // gone by now (a thread switch unmounted the composer), and focusing a
    // detached node silently does nothing while leaving focus on <body>.
    if (target !== null && target.isConnected) target.focus();
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
    // The native submenu owns the keyboard from here, so the bar should not
    // also be holding focus when it closes. `exitBar` is a no-op for the mouse
    // path (nothing was remembered) and returns the caret for the Alt path.
    exitBar();
  }, [exitBar]);

  // Global: Alt enters the bar; Alt+<letter> opens by mnemonic. These must be
  // global because focus isn't on the bar yet. In-bar navigation (arrows,
  // Enter/Space, Escape) is handled on the <nav> once it actually holds focus.
  useEffect(() => {
    if (items.length === 0) return;
    // Whether Alt has been held with nothing else pressed since. Plain Alt
    // activates the bar on KEY UP, not key down, and only if it was released
    // alone — the actual Windows convention, and the only way to tell "Alt"
    // from the Alt half of a chord, which is indistinguishable at key-down
    // time.
    //
    // Activating on key down cost a real editing shortcut: entering the bar
    // moves DOM focus to the File button (the effect above), so pressing
    // Alt+Enter in the composer sent the Alt to the menu bar and the Enter to
    // a menu button instead of inserting a hard break. The Linux E2E lane
    // caught it — the same handler has been mounted on Windows all along,
    // where the Playwright suite does not run.
    let altAlone = false;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Alt") {
        // Auto-repeat while held is still "nothing else pressed".
        if (!event.repeat) altAlone = true;
        return;
      }
      // Any other key ends it, whether or not Alt is part of the chord:
      // Alt+Enter, Alt+ArrowUp, and plain typing all disqualify the release.
      altAlone = false;
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
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== "Alt") return;
      if (!altAlone) return;
      altAlone = false;
      event.preventDefault();
      if (focusedPosRef.current === null) enterBar();
      else exitBar();
    };
    // Alt+Tab and Alt+click leave without a key-up we would ever see, so the
    // window losing focus has to clear the flag too — otherwise the next
    // stray Alt release lands the operator in the menu bar.
    const onBlur = (): void => {
      altAlone = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [items, openMenu, enterBar, exitBar]);

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
        // Same exit as a second Alt: clear the highlight, drop the focus ring,
        // and put the caret back where it was.
        exitBar();
      }
    },
    [items, focusedPos, openMenu, exitBar],
  );

  // Clear the keyboard-focus state when focus leaves the bar entirely (click
  // elsewhere, Tab away) so the highlight never sticks. Moving focus between
  // two entries keeps relatedTarget inside the <nav>, so navigation doesn't
  // trip this.
  const onMenuBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>): void => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setFocusedPos(null);
        // Focus left the bar some other way (a click elsewhere, Tab). There is
        // nothing left to restore, and holding a stale element would send the
        // caret somewhere surprising on the next Alt.
        returnFocusRef.current = null;
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
