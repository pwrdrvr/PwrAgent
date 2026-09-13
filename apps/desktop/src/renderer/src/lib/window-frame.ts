import { getDesktopApi } from "./desktop-api";
import { paintsOwnWindowControls } from "./window-chrome";

/**
 * This window's maximize state, shared by everything that draws from it.
 *
 * Two surfaces need it and neither can ask the DOM: the painted caption button
 * picks its glyph from it, and the window hairline — the edge Electron gives a
 * frameless Linux window none of — has to disappear once the frame is flush
 * with the screen. The window manager maximizes windows without going through
 * our buttons (a double-click on the drag strip, Super+Up, a tiling keybind),
 * so main pushes the changes (`window-frame-sync.ts`) and this follows them.
 *
 * One subscription per window, started from `main.tsx` beside the platform
 * stamp, because EVERY window kind needs the attribute — including the
 * auxiliary ones that paint no strip of ours but still get the hairline. The
 * `<html data-window-frame>` attribute is how `app.css` reads it;
 * `subscribeWindowFrame` is how components do.
 *
 * Linux only: nothing else paints from this, and elsewhere the subscription
 * would be a per-window IPC listener feeding a rule that cannot match.
 */
let maximized = false;
let started = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  document.documentElement.dataset.windowFrame = next
    ? "maximized"
    : "restored";
  if (next === maximized) return;
  maximized = next;
  for (const listener of [...listeners]) listener();
}

/** Call once per window, before the first render. */
export function startWindowFrameSync(
  platform: string | undefined = getDesktopApi()?.platform,
): void {
  if (started || !paintsOwnWindowControls(platform)) return;
  started = true;
  // Stamp the restored default up front so the hairline paints on the first
  // frame. Main re-sends the real state on `did-finish-load`, which is what
  // corrects a window that came back already maximized.
  apply(false);
  getDesktopApi()?.onWindowFrameState?.(apply);
}

export function subscribeWindowFrame(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function isWindowMaximized(): boolean {
  return maximized;
}

/** One module instance serves a whole test file; start each test from zero. */
export function __resetWindowFrameForTests(): void {
  started = false;
  maximized = false;
  listeners.clear();
  delete document.documentElement.dataset.windowFrame;
}
