# Quit Retries

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Quit Retries

A quit that a `before-quit` listener defers is re-issued from a macrotask,
through `retryQuitAfterDispatch` in
[`src/main/shell/quit-retry.ts`](../src/main/shell/quit-retry.ts). That includes an
`app.quit()` the quit manager runs synchronously while the listener is still
on the stack. Never call `app.quit()` from the listener itself or from a
promise chain that can settle in microtasks.

- Electron 41's `Browser::Quit()` assigns `is_quitting_` after the
  before-quit emit returns. An emit that starts from a native task (Dock →
  Quit, logout, Electron's own SIGTERM handling) runs a microtask checkpoint
  before that assignment, so a nested pass's quit is overwritten. The windows
  close, Electron emits `window-all-closed` instead of `will-quit`, and the
  process can stay alive with no windows. PwrSnap shipped that stall in
  pwrdrvr/PwrSnap#659 and fixed it in pwrdrvr/PwrSnap#677.
- Here the `window-all-closed` handler re-issues the quit after resource
  shutdown completes, which hid the lost pass. It is not a substitute: it
  stands down during an update install, and a pass that skipped resource
  shutdown never satisfies it.
- `menu.ts` quits through a click handler, and the main process installs its
  own SIGTERM handler, so neither ⌘Q nor a signal reaches `before-quit` from a
  native task. Dock → Quit and a logout still do.
- Playwright E2E quits from JS, which never nests, so E2E cannot catch this.
  The "under a native quit" tests in `__tests__/index.test.ts` run the real
  handlers through
  [`__tests__/helpers/electron-quit-model.ts`](../src/main/__tests__/helpers/electron-quit-model.ts).
  `pnpm --filter @pwragent/desktop probe:quit-reentry` checks that model
  against the shipped Electron with hidden windows. Re-run it on an Electron
  major bump.
