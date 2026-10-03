# Desktop renderer recovery

The desktop UI can fail while the Electron main process continues running
agents, queues, messaging, and federation. Recovery must preserve that ownership:
it never restarts the app, closes the shell, or resubmits a turn.

## Evidence and primary sources

The operator's 2026-10-02 v1.1.5 incident was a React root-boundary failure.
Main, federation, and agent turns remained alive. Clearing the boundary's report
restored the UI for the observed 15 seconds. Release-matched source maps located
the throw at `ComposerErrorRail.tsx:32:5`; the initiating production loop remains
unreproduced. The connection to the separately reproduced navigation admission
failure is unproven. PR [#2503](https://github.com/pwrdrvr/PwrAgent/pull/2503),
squash-merged at `dd6eae534`, retains bounded multiline stacks, removes
effect-driven composer dismissal cleanup, and coalesces navigation reads.

Primary-source research, accessed 2026-10-03:

| Source | Verified pattern and relevance |
| --- | --- |
| [React error #185](https://react.dev/errors/185) | Identifies maximum update depth, consistent with the reported boundary failure. It does not establish the initiating loop here. |
| [React Component: error boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary) | `getDerivedStateFromError` displays a fallback; `componentDidCatch` supplies an error and component stack for diagnostics. A boundary does not catch event-handler, ordinary asynchronous, or its own errors. |
| [React state preservation](https://react.dev/learn/preserving-and-resetting-state) | Removing a component destroys its local state. State that must survive must live outside the removed subtree. |
| [Electron crash reporting](https://www.electronjs.org/docs/latest/tutorial/crash-reporting#reacting-to-crashes-at-runtime) | Native termination is distinct from a JavaScript exception. The guide demonstrates `render-process-gone`, reason/exit-code logging, and bounded reload retries. Its retry policy is an example, not a guarantee for PwrAgent. |
| [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents#event-render-process-gone) | Reports renderer disappearance separately from `unresponsive`. `forcefullyCrashRenderer` can terminate a shared renderer process, so crash probes need an isolated fixture. |
| [Slack: Building Hybrid Applications with Electron](https://slack.engineering/building-hybrid-applications-with-electron/) | This historical engineering account describes restarting an individual team renderer without affecting the rest of the app. It does not specify current retry limits, React remounts, or draft retention. |

The user's observations that Slack and Spotify sometimes reload themselves are
user-provided context. No primary source found in this research establishes
Spotify's automatic recovery mechanism or retry policy. Spotify's
[own open-source page](https://www.spotify.com/ps-en/opensource/) identifies CEF
in its desktop client; that is not evidence of Electron or a reload policy.

## Recovery policy

| Failure | Automatic action | Limit and fallback |
| --- | --- | --- |
| Root React error boundary | Report the JavaScript and React stacks plus attempt/action metadata, show the fallback, then clear the report after one second. The fallback already unmounted the failed subtree, so clearing it mounts a fresh UI in the same document. | Two automatic remounts for the boundary lifetime. Further failures remain on a usable fallback with **Try again**. Manual retries do not replenish the budget. |
| Main/federation shell renderer termination | Main logs webContents ID, reason, exit code, and recovery attempt, then reloads the same webContents after one second. | Two automatic reloads for the BrowserWindow lifetime, including across successful loads. Further failures or a failed replacement load offer a native **Reload window / Leave window** dialog. Manual reloads do not replenish the budget. Clean exits and destroyed windows do not retry; closing cancels queued retries. |
| Unresponsive renderer, global error, or unhandled rejection | Existing reporting remains in place; no automatic recovery is inferred. | An unresponsive page might resume, and an asynchronous error does not necessarily invalidate the UI. Those need separate evidence and ownership decisions. |

Budgets deliberately have no healthy-period reset. A recurring persistent fault
cannot establish an endless periodic retry cycle. The counters and checkpoints
are window-local memory; this feature adds no SQLite writes or idle timers.
Main's existing `render-process-gone` handler still stops its window diagnostics.
Renderer termination no longer invokes the main-window shutdown path; only an
actual window close participates in the existing quit-confirmation flow.
This feature does not add minidump collection or uploads.

The same React boundary protects auxiliary routes. Automatic native termination
recovery is installed on main/federation shell windows; auxiliary BrowserWindows
retain their existing native lifecycle. **View → Reload Window** is always
available, including after dismissing the native recovery dialog. Developer
Tools and force reload remain developer-mode controls. Recovery does not restore
a main-process crash.

## State preservation and limitations

`RendererRecoveryStateProvider` lives above the boundary. It owns the existing
window-local composer store and its durable wrapper, retaining their identity,
active draft text, editor document, skill tokens, image/file references, parked
drafts, pending steers, and queued-turn projections. Composer cleanup saves its
latest snapshot into that surviving store. Hydration and the existing five-second
save interval continue during the fallback; recovery does not dispatch drafts.
The provider hydrates only routes with composers.

Only committed navigation state is checkpointed: selection, shell view, local
launchpad metadata, the active federated launchpad, and Back/Forward stacks.
The restored UI refreshes main-owned projections and subscriptions. Failed
renders are not checkpointed. Each window has its own provider; drafts never
become federated or cross-window shared state.

A native renderer death or full page reload destroys these in-memory checkpoints.
Saved composer drafts remain available through the existing durable recovery
store, but the last unsaved interval (normally up to five seconds, or longer if
a save failed) can be lost. Window bounds, native identity, and federation target
survive because main reloads the existing shell. Selection/history reset on
native reload; saved drafts can be opened again by selecting their thread.

React remounts also reset ephemeral component state: editor caret/undo history,
transcript scroll position, open menus/dialogs, unsaved Settings forms, and
auxiliary view state that has no existing persistence. An in-flight launch or
attachment conversion must still obey its existing ownership rules; recovery is
not a transactional snapshot of every UI operation. The underlying production
loop is not reproduced or claimed fixed by recovery.

## Regression coverage

- Boundary tests cover transient success, persistent and recurring faults,
  diagnostic stacks/attempt metadata, manual retry without budget reset, and
  cancellation on unmount.
- Provider tests cover Strict Mode remounts, exact rich draft snapshots, parked
  drafts, main-owned queue identities, committed selection, and window isolation.
- Main tests cover termination evidence before reload, lifetime limits, native
  fallback, close/clean-exit handling, and an actual `ThreadTurnQueue` completing
  its running entry and admitting its queued successor after recovery.
  Bootstrap tests verify that termination retains agent, messaging, and
  federation resources and cannot approve an unanswered quit confirmation.
- `renderer-recovery.spec.ts` uses contrived replay data to test an actual root
  boundary remount with an unsent composer draft while main consumes a turn's
  completion, persistent boundary fallback/manual recovery, and real Electron
  renderer termination with durable draft restoration and unchanged main/window
  identity. It does not exercise live federation peers or reproduce the original
  maximum-depth loop.
