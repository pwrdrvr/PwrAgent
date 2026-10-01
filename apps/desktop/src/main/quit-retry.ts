/**
 * Re-issue a quit that a `before-quit` listener deferred, or that the quit
 * manager allowed while a `before-quit` dispatch is still on the stack.
 *
 * Always from a fresh macrotask, never from the promise chain that settled
 * the deferral and never synchronously from the listener. Electron's quit
 * state machine (shell/browser/browser.cc, measured on 41.10.7) is:
 *
 *   Browser::Quit():              if (is_quitting_) return;
 *                                 is_quitting_ = HandleBeforeQuit();  // emits before-quit
 *   Browser::NotifyAndShutdown(): emits will-quit;
 *                                 if (prevented) is_quitting_ = false;
 *
 * An emit that starts from a native task (Dock → Quit, a logout, an Apple
 * Event quit, Electron's own SIGTERM handling, and every will-quit, which
 * the last window's close emits) runs a microtask checkpoint as it returns,
 * still inside those functions. An `app.quit()` issued from the listener
 * itself, or from a chain that settles in that checkpoint, therefore runs a
 * nested pass: it sets `is_quitting_ = true` and starts closing windows,
 * then the outer pass returns and writes `false` over it. The windows finish
 * closing with Electron believing it is not quitting, so it emits
 * `window-all-closed` instead of `will-quit`.
 *
 * In PwrAgent the `window-all-closed` handler re-issues the quit once
 * resource shutdown has completed, which hides the lost pass. Do not rely on
 * that: it does not run during an update install, and a pass that skipped
 * resource shutdown never satisfies it.
 *
 * `scripts/electron-quit-reentry-probe.mjs` measures this on the shipped
 * Electron; `__tests__/electron-quit-model.ts` models it for unit tests.
 * A macrotask cannot run until the outer pass has returned, so the retry
 * always starts from a settled state.
 */
export function retryQuitAfterDispatch(quit: () => void): void {
  setImmediate(quit);
}
