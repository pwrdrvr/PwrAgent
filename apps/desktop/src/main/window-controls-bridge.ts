import { BrowserWindow, ipcMain } from "electron";
import { WINDOW_CONTROL_CHANNEL } from "../shared/ipc";

/**
 * Back the caption buttons the renderer paints on Linux.
 *
 * macOS draws stoplights into the inset strip and Windows fills the Window
 * Controls Overlay, so on those two the OS owns minimize / maximize / close.
 * A frameless Linux window has neither: without this bridge it has no window
 * buttons at all. The renderer owns the pixels (`WindowControls.tsx`);
 * everything that touches the window itself stays here.
 */

/** The slice of BrowserWindow a control action needs. */
export type ControllableWindow = Pick<
  BrowserWindow,
  | "isDestroyed"
  | "isMaximized"
  | "minimize"
  | "maximize"
  | "unmaximize"
  | "close"
>;

/**
 * Run one control action.
 *
 * It answers nothing: the button redraws from the window's own `maximize` and
 * `unmaximize` events (`window-frame-sync.ts`), which is the only account that
 * stays honest when the window manager declines a `maximize()` or maximizes
 * from somewhere else entirely. An unknown action is ignored rather than
 * trusted — this arrives over IPC, and `close()` is not something to reach by
 * falling through a switch.
 */
export function applyWindowControl(
  window: ControllableWindow,
  action: unknown,
): void {
  if (window.isDestroyed()) return;

  switch (action) {
    case "minimize":
      window.minimize();
      return;
    case "toggle-maximize":
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
      return;
    case "close":
      window.close();
      return;
    default:
      return;
  }
}

let wired = false;

/** Register once; every window's renderer shares the channel. */
export function wireWindowControlsBridge(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle(WINDOW_CONTROL_CHANNEL, (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window !== null) {
      applyWindowControl(window, action);
    }
  });
}
