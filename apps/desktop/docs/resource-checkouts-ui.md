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
| `src/renderer/src/features/resources/ResourcesScreen.tsx` | The screen, mounted in the standalone `ResourcesWindow`. |
| `src/renderer/src/features/resources/preview/` | Invented fixtures, a simulated authority, and the dev-only preview window. |

## Entry points and gating

The local profile menu exposes Resources once the owner serves
`openResourceCheckoutsWindow`. The popout reads through these optional
`DesktopApi` methods (`lib/desktop-api.ts`):

```ts
readResourceCheckouts?: () => Promise<ResourceCheckoutsSnapshot>;
onResourceCheckoutsChanged?: (callback: (event: ResourceCheckoutsChangedEvent) => void) => () => void;
performResourceCheckoutAction?: (request: ResourceCheckoutActionRequest) => Promise<ResourceCheckoutActionResult>;
```

`createDesktopResourceCheckoutsSource` returns `null` when any of them is
missing. The profile menu places **Resources** under Usage Activity. It
opens or focuses one native utility window without covering the thread
window. A stored view from the earlier in-window explorer opens the thread
view. Clicking a holder opens that thread in the primary window.

The popout shows the local instance's catalog, including external resources
it can see over Federation. Remote viewer windows have no checkout UI.
The popout shares the local owner's existing service and monitor.

## Owner wiring

The owner starts the [resource checkout authority](resource-checkout-authority.md)
for an active profile and returns it to the Electron shell. The local main
and Resources windows expose the checkout preload methods through
`resource-checkout-ipc.ts`. The authority derives the operator identity
after the handler verifies the sender is the top frame of a permitted local
window. Only the popout subscribes to checkout change events.

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
    shows **Ownership unresolved** and blocks every action except
    `resolve_ownership`. The inspector shows `ownershipConflict.reason` and
    its `remedy`. When the conflict carries a `resolution`, the callout
    offers it under the resolution's label, and the dialog shows its
    `consequence` before sending. See
    [Ownership unresolved](resource-checkout-authority.md#ownership-unresolved);
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
- **One canonical key rule.** A key is a lowercase scheme, a colon and an
  identifier, such as `device:bench-scope/usb-3`; `machine:` is reserved for
  this machine's capacity. The Register dialog checks it as the operator
  types with `canonicalResourceKeyProblem` from the shared contract, the
  same function the main process parses with, and keeps **Save draft**
  disabled while it reports a problem.

## Action semantics

- Each operator intent carries one `idempotencyKey` (`rco-<uuid>`). A dialog
  reuses its key when the operator presses **Send again** after an `unknown`
  outcome, so a retry cannot double-apply. Separate steps and deliberate
  retries after confirmed rejections get fresh keys. Dialog-less actions (`extend`,
  `cancel_request`) keep one key per target (allocation and generation, or
  queue entry) until a definite outcome, so clicking again after `unknown`
  resends the same key.
- Several actions can be in flight at once. Each one's button stays busy
  until its own result arrives.
- Grant-scoped actions (`release`, `extend`, `fence`, `verify_cleanup`,
  `administrative_release`) carry the `allocationId` and `generation` the
  operator saw. Reject a stale generation with `stale_generation`.
- The authority supplies recovery evidence and gates for each failed
  allocation. The recovery dialog stays bound to the selected allocation
  even as other jobs enter or leave recovery.
- `request` comes from the operator, and its holder is the operator. It
  never names a thread as owner. On counted resources the operator selects
  the unit count. Agents request through their own tools.
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
