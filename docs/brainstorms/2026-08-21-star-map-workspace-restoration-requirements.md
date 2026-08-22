# Star Map durable workspace restoration — product requirements

**Date:** 2026-08-21
**Status:** accepted product requirement; implemented on the feature branch
**Scope:** restore the operator's working Star Map after closing and reopening it, including open chats, attached context and terminal cards, geometry, and the useful part of the camera state.

This note records the requirement behind the operator feedback. It is a decision record, not an implementation script.

---

## 1. Outcome

Closing and reopening Star Map must feel like returning to a desk, not generating a new dashboard.

The operator should see approximately the same chats, in approximately the same relationships, with the same context sidebars and terminal cards open. Restoration must not depend on the owning PwrAgent instance being connected. A disconnected thread can be stale, but it must not disappear from the saved workspace.

"Approximately" allows PwrAgent to keep cards reachable when a window, lens, canvas, cloud, or card has changed. It does not permit silently discarding the arrangement.

## 2. Current gap

Star Map currently persists and federates operator-dragged offsets for thread cards and load cards. Those offsets are relative to generated slots, which already gives the base map useful resilience across viewport and topology changes.

Floating chat cards are different today:

- The open chat set is React state only.
- Each chat rectangle is React state only.
- Context-sidebar open state is React state only.
- Terminal open state and terminal height are React state only.
- Card stacking order is React state only.
- The map camera begins as a fresh view on each mount.
- Chat-card movement and resizing do not use the thread-card alignment and spacing guides.

Closing Star Map therefore loses the working surface even though the underlying thread-card arrangement survives.

## 3. Workspace ownership

The restored workspace is **viewer-owned profile state**.

- Persist it in the local PwrAgent profile database under `PWRAGENT_HOME`, not in a remote instance and not only in browser `localStorage`.
- Do not derive workspace membership from the current local or federated navigation feeds.
- Do not federate the open chat set, context-sidebar state, terminal state, or camera as part of the shared fleet arrangement. Opening a transcript is a viewing action on this machine, not a command to open it on every machine.
- Cross-device personal-workspace sync can be designed separately. It must not be smuggled into the existing shared card-arrangement protocol.
- If more than one Star Map window can edit the same workspace, use revisions or last-writer-wins timestamps at semantic update boundaries so one window cannot overwrite a newer complete snapshot accidentally.

## 4. Durable chat identity and disconnected restoration

Every saved chat must include enough identity and display data to restore without its owner:

- Owning federation instance ID, including the durable local instance ID.
- Backend source and thread ID.
- A versioned, bounded thread-display snapshot: title, directory labels or paths needed by the card, and the federation reference needed to reconnect.
- The saved geometry and panel state described below.

The owning instance ID is part of the durable card key. A backend/thread ID pair alone is not sufficient across a fleet.

On Star Map startup:

1. Read the workspace before waiting for federation navigation feeds.
2. Render saved cards immediately from the bounded display snapshot.
3. Mark cards whose owner is unavailable as disconnected or stale without removing them.
4. Disable or explain actions that require the unavailable owner; keep local actions such as move, resize, close, and rearrange available.
5. Rehydrate transcript and live thread data when the owner reconnects, without changing the card's restored geometry.

Persisting "terminal open" restores the terminal card and its geometry. It does not promise to resurrect a dead shell process or pretend a disconnected remote terminal is live.

## 5. Relative geometry

Save chat geometry in Star Map canvas units, not screen pixels. A saved card has both an anchor relationship and a last-resolved rectangle:

```ts
type StarMapWorkspaceAnchor =
  | { kind: "thread"; instanceId: string; threadKey: string }
  | { kind: "instance"; instanceId: string }
  | { kind: "canvas" };

type StarMapWorkspaceGeometry = {
  anchor: StarMapWorkspaceAnchor;
  dx: number;
  dy: number;
  width: number;
  height: number;
  fallbackRect: { left: number; top: number; width: number; height: number };
};
```

The exact persisted schema may differ, but it must preserve these semantics.

Anchor resolution follows this order:

1. The thread card, when that card is present in the current lens.
2. The owning instance's cloud or body, when the thread card is unavailable.
3. The last-resolved canvas rectangle, when neither relative anchor can be resolved.

Important behavior:

- A cloud or source thread card moving between sessions carries its related chats with it.
- A temporarily filtered, folded, missing, or disconnected thread still opens at its last useful canvas location.
- If restoration used the fallback rectangle because an anchor was missing, a later peer connection must not make an already-visible chat jump. Adopt the newly available anchor on the next operator move or the next save boundary.
- Lens changes may resolve the same saved relationship through different visible anchors. Keep one open-chat workspace across lenses; do not silently create separate open sets.
- Clamp only enough to leave the title bar or another move handle reachable. A different viewport size must not flatten the arrangement into a new auto-layout.
- Context and terminal cards are satellites of the chat card. Their positions derive from their host so the compound group moves as one.

## 6. Saved state

For each open chat, save at least:

- Durable fleet-qualified identity.
- Bounded display snapshot for offline restoration.
- Relative anchor and fallback rectangle.
- Chat width and height.
- Whether the context sidebar is open.
- Whether the terminal is open.
- Operator-adjusted terminal height and any future adjustable satellite dimension.
- Stack order or another stable front-to-back ordering.

Save the Star Map view per layout lens:

- Camera pan and zoom after the operator has moved it.
- The current layout lens and existing view preferences continue to restore.
- On a changed viewport or canvas, restore and clamp the camera rather than replaying raw screen coordinates.
- If the saved camera cannot show any saved chat group, prefer a bounded view containing the most recently active saved chat over opening onto empty sky.

Transient composer text continues to use the existing draft system. Do not duplicate draft bodies inside the Star Map workspace record.

## 7. Sizing, alignment, and grids

Open chats should use the same visual placement language as the cards already arranged on Star Map.

- Reuse the existing absolute-canvas alignment and observed-spacing engine instead of adding a second, subtly different snapping system.
- Preserve a screen-space snap threshold so snapping feels the same at every zoom.
- Moving a chat group should align left, center, right, top, middle, and bottom edges with nearby chat groups and eligible map cards.
- Reuse gaps already present in the arrangement, with the existing default card gap as the initial detent.
- Resizing should offer equal-width, equal-height, and aligned-edge detents so rows and columns can become clean grids without pixel hunting.
- Treat a chat plus its open context and terminal satellites as one compound bounding box for inter-group spacing. Do not align another card into space occupied by a satellite.
- Keep the existing chat default and minimum sizes as the baseline. Export shared geometry tokens rather than copying numeric constants.
- Show the same alignment guides during the gesture that explain thread-card snapping.
- Provide a temporary modifier to bypass snapping for precise free placement.

Snapped geometry is ordinary persisted geometry. Reopening Star Map must preserve the grid rather than running auto-layout again.

## 8. Persistence and write budget

Workspace persistence must be event-boundary based:

- Write once after a completed move or resize, not on every pointer event.
- Write after open, close, sidebar toggle, terminal toggle, terminal resize completion, and stack-order changes that need to survive restart.
- Write camera state at the end of a pan or zoom gesture, not per animation frame.
- Make a related workspace update one transaction.
- Perform no SQLite writes while a transcript streams, while Star Map is idle, or merely because a navigation or federation snapshot arrived.

Add a checked-in SQLite write budget around the user action itself, following the desktop write-volume guidance. A drag should cost a constant number of commits independent of pointer-event count.

## 9. Restore safety and evolution

- Version the workspace payload or schema.
- Validate finite geometry values and bound stored display snapshots.
- Ignore or quarantine an invalid card record without discarding the rest of the workspace.
- An explicitly closed chat must stay closed after restart.
- A deleted or permanently unavailable thread may remain as an offline card until the operator closes it. Do not infer deletion from one missing snapshot.
- Preserve unknown future fields when practical, or migrate explicitly. Avoid turning an older desktop into a workspace eraser.

## 10. Acceptance scenarios

1. Open five local and remote chats, open context on two, open terminals on three, resize and arrange them in a grid, close Star Map, and reopen it. The same five compound groups return with the same panel states, sizes, order, and approximate layout.
2. Repeat with all remote instances disconnected before PwrAgent starts. Remote cards render immediately as stale/disconnected shells and remain movable and closable.
3. Reconnect one owner. Its card hydrates in place; it does not teleport to a newly resolved anchor.
4. Move an instance cloud between sessions. Chats anchored to it preserve their relative relationship when restoration can resolve that anchor initially.
5. Reopen on a smaller display. Every saved chat remains recoverable, while relative spacing and sizes are disturbed only as much as reachability requires.
6. Close one restored chat, close Star Map, and reopen. That chat does not return.
7. Drag or resize through hundreds of pointer events. The action consumes a constant bounded number of SQLite commits.
8. Stream a busy transcript for several minutes with several chats open. Workspace persistence makes zero streaming-driven commits.

## 11. Non-goals for the first implementation

- Resurrecting terminal processes across an application restart.
- Federating which transcripts this viewer has open.
- Replacing the existing composer-draft persistence.
- Re-running auto-layout over a hand-arranged restored workspace.
- Hiding saved chats merely because their owner, thread feed, filter, or source card is temporarily unavailable.
