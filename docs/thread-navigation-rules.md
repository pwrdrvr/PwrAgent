# Thread Navigation and Reply Rules

Read this before changing thread lenses, Attention membership/order, unread state, drafts, pins, thread/project drag or grouping, reply acceptance, queued sends, or owner/federation behavior that affects them. These rules apply across renderer, owner, and messaging paths.

### Thread model and lenses

- Threads are first-class and may exist without a directory.
- Attention, Drafts, Inbox, Recents, and Directories use one thread lens switch.
- Each lens tab contains only an icon or status indicators.
- Put the lens name in the `aria-label` and tooltip.
- A thread can have links to multiple Git directories.

### History and unsubmitted composers

- Back and Forward can reopen a project's unsubmitted composer, including an empty one.
- Opening another destination after Back clears ordinary Forward visits.
- Keep unsubmitted composers from that abandoned branch in Back, behind the thread just left.
- Thus composer → Back to A → open B → Back visits A, then the composer.
- Keep one entry per composer, keyed by project and owning instance.
- Submitting a composer replaces its entry with the starting thread, then the created thread.

### Attention lens

- Use Attention as the work queue.
- Include threads with a live turn.
- Include threads that wait for review.
- Use two count indicators instead of a tab icon:
  - A scanner for turns in progress.
  - An orange cookie for unread threads.
- Show zero for each empty count.
- Make an indicator grey when its count is zero.
- Do not hide a zero indicator. A missing indicator makes an idle tab appear broken.

### Attention order

- Order Attention by turn, not by activity.
- Inbox lists by `updatedAt` and Recents by `createdAt`, each below its Pinned group when pins are on top.
- Do not use `updatedAt` to order Attention.
- `updatedAt` changes for each streamed item, subagent call, and tool result.
- Activity ordering would move queue items while the operator uses the queue.
- Give each Attention member a rank when its turn starts.
- Keep that rank for the complete turn.
- A thread can move at most twice during one turn.
- The optional second move occurs when the turn ends.
- `general.attention_promote_on_turn_end` controls that move and defaults to on.
- When enabled, move a finished turn to the top for review.
- Apply this promotion to a turn that the current window observed.
- Also apply it to a turn that starts and finishes between polls.
- Messaging and peer-driven turns can use this case.
- For that case, treat an idle member with a newer `updatedAt` as a finished turn.
- Never use this detection path for a live turn.
- Use a monotonic counter for ranks. Do not use a clock.
- Do not call `Date.now()` from the render path.
- Do not create rank ties.
- Scope ranks to current Attention membership.
- If a thread leaves and returns, give it a new rank at the top.
- The reducer and design rationale are in [attention-order.ts](../apps/desktop/src/renderer/src/features/navigation/attention-order.ts).

### Drafts lens

- Drafts is the second state lens.
- Use Drafts for threads that contain unsent composer text.
- Sort Drafts by recent activity.
- Store a draft on the machine where the operator writes it.
- Store the latest draft in `composer_draft_latest`.
- Restore that draft during the next application launch.
- Never federate draft text.
- A viewer can draft a reply to a thread from a peer instance.
- Show the Draft chip only to that viewer.
- Do not show that draft to the instance that owns the thread.
- This rule prevents publication of an operator's unsent text.
- Show the Draft chip in every lens.
- The current implementation has two intentional limits:
  - Draft storage is machine-wide, but each window reads it only during mount.
  - A second window does not update its Draft chips until it restarts.
  - Launchpad composer text has no thread row.
  - Therefore, the lens label uses `replies`.
  - Its empty state is `No unsent replies.`

### Inbox, Recents, and Directories

- The code names and the tab tooltips differ: `inbox` is the **Updated**
  tab and `recents` is the **Created** tab. No tab is labelled Recents.
- Use Inbox as the default browsing lens.
- Sort Inbox by recent activity.
- Show all threads in Inbox.
- Show all threads in Recents.
- `general.pinned_threads_on_top` decides where pins go in both lenses.
  It defaults on, and it lives in **Settings → General → Pinned threads**.
  - On: Inbox and Recents share one collapsible **Pinned** group above
    their time-sorted list.
  - Off: both are pure sorts. Each pinned thread keeps its `updatedAt` or
    `createdAt` position, and neither lens shows pin-order controls.
  - Never re-sort pins by time inside the group. Pin order is the
    operator's own, and it must read the same on every tab.
  - Directories ignores the setting; each project keeps its pins on top.
- The Pinned group:
  - Holds every pinned root from every project, including threads with no
    directory and pinned peer threads. A root's sub-threads stay in its tray.
  - Order the group by the global pin rank (`comparePinnedThreads`).
    Reordering there and in a Directories project changes the same rank.
  - A thread renders once. A pinned root is never in the list. Unpinning
    returns it to its slot in the list's own order.
  - The collapsed header shows the pin, **Pinned**, the count, and the
    Attention tab's two indicators scoped to the group. Both stay visible
    and grey at zero, so collapsing never hides a live turn or unread work.
  - One collapsed state serves both lenses. Persist it per profile in the
    state DB, beside the selected lens. Never in `config.toml`. One commit
    per toggle.
  - Revealing a pinned thread from search or the jump palette opens a
    closed group. Pinning a thread opens it too.
  - The group pages separately (`lens-pins`, 100 rows) from the list
    (`lens`, 10 rows). An owner that predates the split ignores `roots`,
    so the renderer also filters each page by each root's own pin.
  - Draw no group when no pin exists or none matches the lens filter.
  - The list below the group keeps no pin-order controls.
  - While the group is drawn, the list sits in a section with the same header
    (caret, icon, count, collapsed readouts), so the operator can fold it and
    keep only the pins on screen. The header is the lens tab's own name and
    icon (**Updated** or **Created**), never "Recents"; the icon stays
    neutral. Its collapse is window-local view state, not persisted, and
    independent of the group's.
    A newly selected thread or a starting thread inside it reopens it.
    Removing the last pin drops the fold, so the next pin shows the list
    open; a lens switch, whose pins are still loading, keeps it.
- Offer visible pin ordering in Directories and in the Pinned group.
  Both use `useThreadPinOrdering`; do not fork it.
- The pin-order controls are:
  - Drag.
  - The `⌘⇧↑` and `⌘⇧↓` shortcuts.
  - **Move Up** and **Move Down** in the context menu.
- Within each directory, show pinned threads first.
- Pins have two tiers: pins kept at top, then ordinary pins.
  - The tier lives in the rank: kept pins use a band below
    `KEEP_AT_TOP_RANK_BOUNDARY` in `packages/shared/src/thread-pins.ts`.
    Every rank sort, store, and federation hop already orders it first.
  - A new pin, including an auto-pinned new thread, lands at the top of the
    ordinary pins and never above a kept pin.
  - Cross tiers only explicitly: the **Keep at Top** check item in the
    context menu, or a drag. Move Up, Move Down, and the shortcuts stay
    inside the pin's tier.
  - A pin drag shows a ghost Keep at top slot: above the pins while no pin
    is kept, else below the last kept pin. Only a drop inside the slot's own
    box keeps. The slot must not overlap a row.
  - A drop on a pin row adopts that row's tier. The line above the first
    ordinary pin is the top of the ordinary pins; the lower half of the
    last kept pin is the end of the kept pins.
  - The **Pinned** and **Keep at Top** check items toggle in place and keep
    the menu open. Return or a click outside closes it.
- Sort unpinned directory threads by thread creation time.
- Project folders, sub-threads, and pins all use one pointer drag:
  a 4px lift, the tilted held card, the dimmed source, Escape to cancel.
  Never native HTML drag (see `pointer-reorder-drag.ts`).
  - Holding a project header folds Directories to one line per project
    (`.is-folding-directories`), so a drop is a choice between folders.
    It is a class on the list, never a disclosure change.
  - A pinned folder dropped below the **Directories** divider is unpinned.
  - Only a tray's direct children reorder, across providers. The owner
    resolves each child's provider from its own child list.
  - A thread dropped on another thread's row becomes its sub-thread
    (`thread-nest-drop.ts`). The row wears an accent ring and the held card
    says **Make sub-thread**. On a row that is also an order target (a pin
    in its scope, a sibling in the tray) only the middle third nests; the
    outer thirds keep the line, and an unpinned thread's edge drop still pins.
    The target's closed tray opens. Nesting unpins the thread, and its own
    sub-threads move with it.
  - Offer a nest only when the owner will keep it: both threads on one
    owner that can group, no provider sub-agents, not the current parent,
    and never one of the thread's own sub-threads. The owner refuses a
    loop in `setThreadParent` too, because a loop drops every member from
    every lens. Agents use `mutate_thread`'s `parentThreadId` and
    `detachFromParent`, for threads sharing an owner, including connected peers.

### Unread behavior

- Show unread state as an orange cookie on thread rows in every lens.
- In all lenses except Attention, clear unread state when the thread gets focus.
- In Attention, keep unread state when the thread gets focus.
- In Attention, clear unread state only after the operator sends a reply.
- The composer reports accepted sends and steers through `onUserRepliedToThread`.
- That callback calls `markThreadsSeen`.
- Do not apply reply-only clearing to other lenses.
- A global rule would leave read threads unread when the operator does not reply.
- Keep normal focus-based clearing in ordinary browsing lenses.
- Skip `retainedUnreadThread` in Attention.
- That mechanism normally clears a retained thread when the operator leaves it.
- Apply the exemption to the Attention lens, not to a thread.
- If the operator leaves Attention, clear the selected thread's unread state.
- This rule applies when the selected thread remains selected in the next lens.
- Tests in `useThreadNavigation.test.tsx` enforce both parts of this transition.

### Reply acceptance

- Report a reply only after the backend accepts it.
- Do not report a reply when the operator only attempts it.
- Call `onUserRepliedToThread` only after `startTurn` or `steerTurn` resolves.
- Apply the same rule when `useQueuedTurnRelease` sends a queued turn.
- If the send fails, keep the thread in Attention.
- Early reporting would remove a thread for a message that never left the machine.
