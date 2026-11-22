# Resource Checkouts UI

The Resources screen shows the operator every scarce resource PwrAgent
coordinates: one row per canonical capacity domain, its holder, queue,
readiness, instructions, authority, and cleanup or recovery state. Agents
check resources out; the operator watches, takes a manual hold, releases, and
recovers.

The product requirements are in the Linear PRD "Resource checkouts across
profiles and the Federation". The interactive design is the Claude Artifact
linked from the PR that added this screen.

This screen owns no allocation logic. It reads snapshots and sends typed
action requests through one data source. The allocator, the machine broker,
the Federation coordinator, provider adapters and their storage are separate
work.

## Files

| Path | Role |
|---|---|
| `packages/shared/src/contracts/resource-checkouts.ts` | The contract: snapshot DTOs, action requests, action results, change event. |
| `src/renderer/src/features/resources/resource-checkouts-source.ts` | `ResourceCheckoutsSource`, and the production factory over `desktopApi`. |
| `src/renderer/src/features/resources/resource-view-model.ts` | Presentation rules: conditions, gates, labels, filters. |
| `src/renderer/src/features/resources/useResourceCheckouts.ts` | Reads, follows change events, and sends actions. |
| `src/renderer/src/features/resources/ResourcesScreen.tsx` | The screen, mounted as a full-window layer like Automations. |
| `src/renderer/src/features/resources/preview/` | Invented fixtures, a simulated authority, and the dev-only preview window. |

## Entry points and gating

The screen and every way into it stay hidden until the main process serves
all three of these optional `DesktopApi` methods (`lib/desktop-api.ts`):

```ts
readResourceCheckouts?: () => Promise<ResourceCheckoutsSnapshot>;
onResourceCheckoutsChanged?: (callback: (event: ResourceCheckoutsChangedEvent) => void) => () => void;
performResourceCheckoutAction?: (request: ResourceCheckoutActionRequest) => Promise<ResourceCheckoutActionResult>;
```

`createDesktopResourceCheckoutsSource` returns `null` when any of them is
missing. With a source:

- The sidebar profile menu shows **Resources** under Usage Activity. The
  masthead is not used: it is width-budgeted for five controls (see the
  container queries above `.sidebar__masthead-automations` in `app.css`).
- `App.tsx` adds the `"resources"` main view. It is a layer view, so the
  sidebar and main go inert and focus returns to the opener on close. A
  restored `"resources"` view without a source falls back to the thread view.
- `"resources"` is an operator focus view (`OPERATOR_FOCUS_VIEWS`), so a
  voice or Star Map turn can tell the operator is on this screen.

Federation viewer windows don't show the profile menu, so they never offer
Resources. The screen always shows the local instance's view, which includes
Federation resources this instance can see.

## Wiring the system (stacked PR)

Follow the Operator Requests precedent (`operator-requests-ipc.ts`):

1. Add channels to `src/shared/ipc.ts`: a read (`resource-checkouts:read`),
   an action (`resource-checkouts:perform`) and a change event
   (`resource-checkouts:changed`).
2. Register handlers in `src/main/shell/ipc/` and call them from
   `src/main/shell/index.ts` with the owner service that holds checkout
   state. Validate every action request in main; the renderer is untrusted.
3. Add the event channel to the main window's list in
   `src/main/shell/main-window-channels.ts`, and broadcast with
   `subscribersForChannel`.
4. Expose the three methods in `src/preload/index.ts`. The profile menu entry
   and the screen appear with no renderer change.
5. Optional: add View → Resources. Extend `WindowOpenMainViewRequest` with
   `"resources"`, add the menu item in `src/main/shell/menu.ts`, and call
   `requestOpenMainView("resources")`. App already handles the view; offer the
   item only when the service is configured.

Do not import the preview fixtures or `createPreviewResourceCheckoutsSource`
from production code. Production never shows invented availability or
simulated results.

## Snapshot semantics

- **One row per capacity domain.** Aliases, advertisements and execution
  routes belong to the resource; never send them as separate resources.
- **`revision` is monotonic per viewer.** The renderer ignores a snapshot
  whose revision is not higher than the one on screen, and ignores a change
  event whose revision it already has. Reads can land out of order.
- **The server decides `condition` and the action gates.** The renderer may
  only make them more conservative:
  - no bound authority, an ownership conflict, or an `unresolved` authority
    shows **Ownership unresolved**, and only `resolve_ownership` stays usable;
  - an authority missing from `authorities`, or not `reachable`, shows
    **Authority unreachable** and blocks every action;
  - `available` with capacity fully held shows **Busy**;
  - `administrative_release` stays blocked until `recovery.fencing` is
    `verified`.

  `__tests__/resource-view-model.property.test.ts` holds these rules.
- **Absent gate means not offered.** A blocked gate is shown disabled, with
  its `detail` in the tooltip. Use `not_authorized` for permission and say
  what the viewer lacks.
- **Busy, unreachable, interactive prerequisite and ownership unresolved** each
  have their own glyph and wording, not only a color.
- **Instructions are untrusted shared content.** Send a bounded plain-text
  `excerpt`. The UI shows it as text and never as an instruction.
- **This machine needs positive evidence.** A `machine_broker` resource is
  listed under This machine only when an advertisement has `isViewer` or
  `onViewerMachine`. Set `onViewerMachine` only after both machine-ids
  resolve and match; an unresolved id leaves a peer's broker under
  Federation.

## Action semantics

- Each operator intent carries one `idempotencyKey` (`rco-<uuid>`). A dialog
  reuses its key when the operator presses **Send again** after an `unknown`
  outcome, so a retry cannot double-apply. Separate steps (fence, then
  verify) get separate keys. Dialog-less actions (`extend`,
  `cancel_request`) keep one key per target (allocation and generation, or
  queue entry) until a definite outcome, so clicking again after `unknown`
  resends the same key.
- Several actions can be in flight at once. Each one's button stays busy
  until its own result arrives.
- Grant-scoped actions (`release`, `extend`, `fence`, `verify_cleanup`,
  `administrative_release`) carry the `allocationId` and `generation` the
  operator saw. Reject a stale generation with `stale_generation`.
- `request` comes from the operator, and its holder is the operator. It
  never names a thread as owner. Agents request through their own tools.
- Results are reports, not state. After any result the renderer re-reads and
  shows what the snapshot says; it never applies a grant or queue entry
  locally. `rejected` keeps the dialog open with the message; `unknown` offers
  **Send again**. A dialog's failure is shown only in the dialog; the
  screen's notice reports successes and failures of dialog-less actions.
- `administrative_release` requires a non-empty `auditNote` and verified
  fencing. It must never erase an active owner.
- `register_definition` creates a `pending_registration` resource. It is not
  requestable and not visible to other instances until the registry confirms
  it.

## Preview

A development build serves the screen at `#resources-preview` (`main.tsx`),
over invented fixtures and a simulated authority with a role switch (Operator,
Member, Viewer). The screen shows a **Preview data** banner whenever its
source's `origin` is `"preview"`. `import.meta.env.DEV` removes the route and
its chunk from production builds.

## Persistence

The screen itself writes nothing. When the service persists allocations,
renewals or audit records, follow the SQLite write-budget rules in
[sqlite-write-volume.md](sqlite-write-volume.md#sqlite-write-volume-instrumentation).
