import { useCallback, useSyncExternalStore, type ReactElement } from "react";
import { getDesktopApi } from "../../lib/desktop-api";
import { isWindowMaximized, subscribeWindowFrame } from "../../lib/window-frame";
import { paintsOwnWindowControls } from "../../lib/window-chrome";
import type { WindowControlAction } from "../../../../shared/ipc";

/** One glyph geometry for all three buttons, so their weights match. */
const glyph = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Linux caption buttons, painted into the title strip.
 *
 * macOS hands us its stoplights and Windows fills the Window Controls Overlay
 * it reserves at the right edge; a frameless Linux window has neither, so it
 * has no minimize, maximize or close at all unless we draw them. Right-hand
 * side, GNOME's order and roundness — that is where Ubuntu puts them.
 *
 * The maximize glyph follows the window rather than the last click: a
 * double-click on the drag strip, Super+Up or a tiling keybind all maximize
 * behind our back, and main pushes those through `onWindowFrameState`.
 */
export function WindowControls(): ReactElement | null {
  // Subscribed unconditionally — hooks cannot sit behind the platform gate —
  // but the store is Linux-only, so off Linux this reads a frozen `false` and
  // the component returns null below.
  const maximized = useSyncExternalStore(
    subscribeWindowFrame,
    isWindowMaximized,
    isWindowMaximized,
  );

  const run = useCallback((action: WindowControlAction): void => {
    void getDesktopApi()?.runWindowControl?.(action);
  }, []);

  if (!paintsOwnWindowControls()) return null;

  return (
    <div className="app-titlebar__controls">
      <button
        type="button"
        className="app-titlebar__control"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => run("minimize")}
      >
        <svg aria-hidden="true" {...glyph}>
          <path d="M4 8h8" />
        </svg>
      </button>
      <button
        type="button"
        className="app-titlebar__control"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => run("toggle-maximize")}
      >
        <svg aria-hidden="true" {...glyph}>
          {maximized ? (
            <>
              <rect x="3.5" y="6" width="6.5" height="6.5" rx="1.2" />
              <path d="M6 3.5h4.5A2 2 0 0 1 12.5 6v4.5" />
            </>
          ) : (
            <rect x="4" y="4" width="8" height="8" rx="1.4" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="app-titlebar__control app-titlebar__control--close"
        aria-label="Close"
        title="Close"
        onClick={() => run("close")}
      >
        <svg aria-hidden="true" {...glyph}>
          <path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8" />
        </svg>
      </button>
    </div>
  );
}
