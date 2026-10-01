/**
 * A model of Electron's quit state machine, for tests that need to know
 * whether a quit actually reaches `quit`. Transcribed from
 * shell/browser/browser.cc, native_window.cc and window_list.cc at v41.10.7:
 *
 *   Browser::Quit()               if (is_quitting_) return;
 *                                 is_quitting_ = HandleBeforeQuit();
 *                                 if (!is_quitting_) return;
 *                                 empty ? NotifyAndShutdown() : CloseAllWindows();
 *   NativeWindow::NotifyWindowClosed
 *                                 emit closed; WindowList::RemoveWindow();
 *   Browser::OnWindowAllClosed    is_quitting_ ? NotifyAndShutdown()
 *                                              : emit window-all-closed;
 *   Browser::NotifyAndShutdown    emit will-quit;
 *                                 if (prevented) { is_quitting_ = false; return; }
 *                                 Shutdown();   // emits quit
 *
 * The part a plain event-emitter fake gets wrong is WHEN microtasks run.
 * An emit that starts from a native task (Dock → Quit, SIGTERM, a window
 * finishing its close) runs a microtask checkpoint as the emit returns,
 * still inside the C++ function, before the code after it. An emit reached
 * from JS (`app.quit()` in a click handler) does not; its microtasks wait for
 * that JS to return. The model reproduces both, and the outcomes it predicts
 * match what apps/desktop/scripts/electron-quit-reentry-probe.mjs measures on
 * the real runtime.
 *
 * Adapted from pwrdrvr/PwrSnap#677 (MIT, same owner).
 */

type QuitEvent = { preventDefault(): void };
type Listener = (event: QuitEvent) => void;

/** The subset of `BrowserWindow` that the quit path touches. */
export type ModelBrowserWindow = {
  id: number;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: string, listener: () => void): void;
};

/** Enough turns to settle any promise chain that does no I/O. */
async function microtaskCheckpoint(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

export class ElectronQuitModel {
  /** Every event emitted, in order. Window closes are `closed:<name>`. */
  readonly emitted: string[] = [];
  /**
   * `Browser::Quit()` passes that began while another pass was still between
   * its before-quit emit and the assignment after it. Every one of these can
   * have its outcome overwritten by the pass it is nested in.
   */
  reentrantQuits = 0;
  private quitting = false;
  private shutdown = false;
  private quitPassesInFlight = 0;
  private nextWindowId = 1;
  private readonly windows = new Map<string, number>();
  private readonly closing = new Set<string>();
  private readonly listeners = new Map<string, Listener[]>();
  private readonly closedListeners = new Map<string, Array<() => void>>();

  constructor(windows: readonly string[]) {
    for (const name of windows) this.openWindow(name);
  }

  get hasQuit(): boolean {
    return this.shutdown;
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  /** `app.quit()` called from JavaScript. */
  readonly quit = (): void => {
    if (this.quitting || this.shutdown) return;
    this.beginQuitPass();
    try {
      this.finishQuit(!this.emit("before-quit"), "js");
    } finally {
      this.quitPassesInFlight -= 1;
    }
  };

  /** `Browser::Quit` run as a native task: Dock → Quit, logout, SIGTERM. */
  async quitFromNativeTask(): Promise<void> {
    if (this.quitting || this.shutdown) return;
    this.beginQuitPass();
    try {
      const prevented = this.emit("before-quit");
      await microtaskCheckpoint();
      this.finishQuit(!prevented, "native");
    } finally {
      this.quitPassesInFlight -= 1;
    }
  }

  /** `new BrowserWindow()`. */
  openWindow(name: string): void {
    this.windows.set(name, this.nextWindowId);
    this.nextWindowId += 1;
  }

  /** `BrowserWindow.getAllWindows()`. */
  browserWindows(): ModelBrowserWindow[] {
    return [...this.windows].map(([name, id]) => ({
      id,
      close: () => this.closeWindow(name),
      destroy: () => this.removeWindow(name),
      isDestroyed: () => !this.windows.has(name),
      once: (event, listener) => {
        if (event !== "closed") return;
        this.closedListeners.set(name, [
          ...(this.closedListeners.get(name) ?? []),
          listener,
        ]);
      },
    }));
  }

  /** Run every pending task, including the ones those tasks queue. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private beginQuitPass(): void {
    if (this.quitPassesInFlight > 0) this.reentrantQuits += 1;
    this.quitPassesInFlight += 1;
  }

  private finishQuit(allowed: boolean, origin: "js" | "native"): void {
    this.quitting = allowed;
    if (!allowed) return;
    if (this.windows.size === 0) {
      void this.notifyAndShutdown(origin);
      return;
    }
    for (const name of [...this.windows.keys()]) this.closeWindow(name);
  }

  /**
   * `BrowserWindow.close()`: the renderer unloads, and the window finishes
   * closing on a later native task.
   */
  private closeWindow(name: string): void {
    if (!this.windows.has(name) || this.closing.has(name)) return;
    this.closing.add(name);
    this.emitted.push(`close:${name}`);
    setImmediate(() => void this.finishWindowClose(name));
  }

  /**
   * `NativeWindow::NotifyWindowClosed` on a native task: the `closed` emit
   * returns through a microtask checkpoint while the window is still listed.
   */
  private async finishWindowClose(name: string): Promise<void> {
    if (!this.windows.has(name)) return;
    this.emitted.push(`closed:${name}`);
    const listeners = this.closedListeners.get(name) ?? [];
    this.closedListeners.delete(name);
    for (const listener of listeners) listener();
    await microtaskCheckpoint();
    this.removeWindow(name, "native");
  }

  private removeWindow(name: string, origin: "js" | "native" = "js"): void {
    if (!this.windows.delete(name)) return;
    this.closing.delete(name);
    if (origin === "js") {
      // `destroy()`: closes synchronously and still emits `closed`.
      this.emitted.push(`closed:${name}`);
      const listeners = this.closedListeners.get(name) ?? [];
      this.closedListeners.delete(name);
      for (const listener of listeners) listener();
    }
    if (this.windows.size > 0) return;
    if (this.quitting) {
      void this.notifyAndShutdown(origin);
    } else {
      this.emit("window-all-closed");
    }
  }

  private async notifyAndShutdown(origin: "js" | "native"): Promise<void> {
    if (this.shutdown) return;
    const prevented = this.emit("will-quit");
    if (origin === "native") await microtaskCheckpoint();
    if (prevented) {
      this.quitting = false;
      return;
    }
    this.shutdown = true;
    this.emit("quit");
  }

  /** Returns whether a listener called preventDefault(). */
  private emit(name: string): boolean {
    this.emitted.push(name);
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return prevented;
  }
}
