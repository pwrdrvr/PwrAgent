# Star Map Manager and the Star Map Agent Tools

The Star Map's **Manager** button opens a long-lived thread the operator talks
to *about the map*: "rename that thread to have an AB test prefix like the
others in its cloud", "steer the two selected cards", "move these into
PwrSnap", "archive the finished ones", "actually, bring that one back",
"pin the release threads", "fly me to the release runbook thread and open
it", "show me only what needs me", "what is Studio actually working on".

Nothing about the manager is a privileged execution path. It is an ordinary
thread with the ordinary PwrAgent tool catalog — `mutate_thread`, the
orchestration tools, the federation tools — plus four tools that let *any*
thread see what is on the map, move its camera, point at cards, and change
the lens. The feature is really those tools; the manager is the affordance
that makes them worth having.

## Why a view snapshot exists at all

The map is drawn entirely in the renderer. Cloud membership, which cards are
folded behind a `+N more` chip, the marquee selection, the camera, and the
active filter chips exist nowhere else — the navigation snapshot knows about
threads, not about what the operator can see.

That is exactly what a request like "the others in its cloud" depends on. So
`StarMapScreen` publishes a `StarMapViewSnapshot` to the main process, and
`read_star_map_view` serves it.

**Push, not pull.** Not because main cannot ask a renderer a question — it can,
and `executeJavaScript` does exactly that elsewhere in the app. A pull at
tool-call time would answer from whichever renderer replied and block the turn
on it; and the other alternative, reimplementing `star-map-clusters.ts` in main,
would drift from what is actually drawn (the renderer boundary forbids importing
it anyway). The cost of pushing is that the view is never newer than the last
publish, which is why every result carries `ageMs`.

**Memory only.** The snapshot turns over as fast as a card drags. Persisting it
would be precisely the per-frame write pattern the repository's SQLite write
budgets exist to catch. `star-map-view-registry.ts` keeps it in a `Map` keyed
by `WebContents.id` and drops an entry when its renderer is destroyed, so a
closed map reports nothing rather than its last frame.

**Throttled.** `useStarMapViewPublisher` publishes on a 750 ms trailing edge and
builds the snapshot *inside* the throttle — the builder walks every cloud and
thread, and the hook sits on the drag path. Callers pass a memoized input, not
a finished snapshot.

## The tools

| Tool | Serves | Messaging RBAC |
|---|---|---|
| `read_star_map_view` | Instances, clouds and their full membership, drawn vs folded cards, selection, open chat cards, camera, filters, and where each drawn card sits. Each thread carries `backend` / `threadId` / `instanceId`. | `tools.thread_inspection` |
| `fly_star_map_to` | Moves the camera to a thread's card, a cloud, or an instance's body, and answers with what it flew to. With `open`, also opens the thread: its chat card on the map, or the full thread view. | `tools.thread_inspection` |
| `highlight_star_map_threads` | Rings a set of cards and frames them, so the operator sees which threads the Agent means before it acts. | `tools.thread_inspection` |
| `set_star_map_view` | Changes the lens and the filter chips, the way the View menu and the chip strip do. | `tools.thread_inspection` |

All four are gated for messaging-originated turns at the same permission as
any other read of thread metadata. They change what the operator is looking
at and nothing else.

The honesty property worth preserving is pinned by tests: **truncation is
reported.** `maxThreads` shortens the thread list but never the clouds' own
counts — a shortened list must not read as a smaller cloud, or "the others in
this cloud" acts on the wrong set. Drawn cards survive truncation ahead of
folded ones.

### Spatial references without pixels

"That card over on the left about Foo" is a position question, and the answer
is numbers rather than an image. Every drawn card reports `rect` in map space
and `screenRect` in viewport pixels, so the leftmost card is the drawn one with
the smallest `screenRect.x` — no rasterising, no OCR, no estimating positions
off an image.

`screenRect` is derived here rather than left to the caller. The canvas carries
`translate(camera.x, camera.y) scale(camera.scale)`, and a CSS transform list
applies right to left, so `screen = map * scale + camera` — **not**
`(map + camera) * scale`, which is what this contract's own comment used to
say. A spatial reference resolved off a flipped transform names the wrong card
and never looks uncertain, which is the worst way for this to fail.

`onScreen` is the other half: a card the layout placed is `visible: true` and
carries geometry even when the operator has panned it out of view, so "the card
on the left" has to exclude it.

### Commands: flying, highlighting, changing the view

`fly_star_map_to`, `highlight_star_map_threads` and `set_star_map_view` are
the paths where main asks the renderer to *do* something, so they share a
command channel rather than riding on the publish. `star-map-command-bus.ts`
sends each command to the renderer behind the view the Agent last read — a
command sent anywhere else would act on a map the Agent never saw — and holds
the tool call open for the answer.

Every command resolves exactly once: with the map's answer, with "the map
closed" if its renderer dies, or with a timeout. A thrown handler in the
renderer is answered too (`useStarMapCommands`), because an unanswered command
costs the turn the full timeout. The answer is trusted only from a Star Map
window, only from the one the command went to, only when it carries that
command's kind, and only if it validates for that kind
(`isStarMapCommandResult`) — it reaches the model as what the map did.

What the destinations mean:

- **A card.** The same `flyToThread` ⌘K uses, so a card the lens is not
  drawing is summoned first. A thread the map has not loaded at all — the
  local feed holds one filtered page — is asked for by identity from its
  owning feed, flown to when it lands, and kept on the map like a ⌘K pick.
  The renderer gives up after ten seconds, before main's fifteen, so the
  Agent hears why rather than a timeout.
- **A cloud.** Resolved against a snapshot built on the spot from the same
  input the publisher uses, so the `cloudKey` the Agent read is the key that
  matches. The camera frames the union of the cloud's placed cards, at card
  zoom for a small cloud and pulled back until a large one fits. The same
  project draws one cloud per instance in the lanes and orbit lenses, so an
  ambiguous key is refused with the instances named.
- **An instance.** Its body, which the projects lens does not draw.

`open: "card"` opens the thread's chat card beside its card once the camera
lands, which is what "let me talk to it" means on the map. `open: "full"`
opens the whole thread instead — this window for a local thread, its owner's
viewer for a peer's — and skips the flight, since it leaves the map.

An Agent flight never moves keyboard focus. The edge arrows' flight does,
for a reason that does not apply here — and the operator is usually typing
into the manager's card while it runs.

**Highlighting** is how the manager asks "these ones?" before it acts on
several threads. The ring is a held version of the ⌘K pick's pulse, and
deliberately not the selection's fill and rail: the selection is what the
operator gathered, and `read_star_map_view` reports it as that, so an Agent
writing into it would read its own pointing back as the operator's intent.
The view reports the ring separately (`highlighted`, `highlightedThreadKeys`).

Threads named by a highlight load the way a flight's do, and it waits for
them the same ten seconds. It then rings what arrived and names what did not
(`missingThreadKeys`), because four of five cards ringed is a better question
than none. Rings are by thread key, so they survive a lens change. They clear
when the Agent clears them, on its next highlight, or when the operator
clicks empty sky — the same gesture that drops their own selection.

**`set_star_map_view`** goes through the same code as the View menu, so a
lens change drops the selection there too, and it stores the lens and chips
the way the operator's own clicks do. There is no per-instance filter to set:
the map has none. "Only Studio" is a flight to Studio's body.

### Why there is no screenshot tool

An earlier revision had a `capture_star_map` beside this one. It was cut before
merge, and the reasoning is worth keeping so it is not re-added by reflex.

A picture cannot do the job. Acting on "that thread" needs a `threadId`, and a
PNG carries titles at best — an Agent would read the label off the image and
still have no handle to call `mutate_thread` with. The spatial case that looks
like it needs pixels is answered by `screenRect` above, and answered more
precisely: an image would be a lossy encode of coordinates this already
reports exactly.

Against that it cost real things: Codex dynamic tools carry text only, and
Codex is the default backend, so the tool returned no image at all for most
operators. It also wanted the higher `tools.instance_management` permission, a
capture and PNG encode per call, and a size ceiling with a downscale-and-retry
path.

What genuinely still needs pixels is appearance rather than position — does a
label collide with a chip, do two clouds overlap, does this look wrong — which
is design and debugging work with better tools already available to it.

## Moving, archiving, restoring, pinning and marking read

These are `mutate_thread` fields, not new tools: `projectPath`, `archive`,
`pinned` and `unread`. That tool already resolves a thread locally or on the
owning peer, supports `dryRun`, and is gated for messaging per field. A field
whose permission is missing fails to compile, so the new fields could not
ship ungated.

- **`projectPath`** is the status card's *Move to Project*: a `to-project`
  workspace handoff that relinks the thread to another checkout without
  copying files. It is gated on `thread.control.handoff`, as that button is.
  The path comes from `list_instance_projects` on the thread's own instance,
  because it is checked on that instance's disk. It runs **before** any other
  field in the same call, so a refused destination leaves the title and
  settings as they were rather than half the request applied.
- **`archive: true`** archives and **`archive: false`** restores, the way
  **Settings → Archived Threads** does, worktrees included. Either one
  stands alone in its call. Both use their own permission,
  `thread.control.archive`, Admin only by default: an archive removes
  worktrees, which no messaging action did before, and a restore brings
  them back. Archiving a thread with a turn running is refused, on a dry run
  too, so a preview says what the real call would. So is archiving one
  already archived, or restoring one that is not.
  A local archive goes through the app's own archive path, which also
  ungroups the thread's children on other instances; the registry cannot
  reach that step itself. A peer's thread is restored through
  `backend.restoreThread`, which a peer older than this change does not
  have — the Agent is told to send the operator to that instance's Settings.
- **`pinned`** pins or unpins the thread on the instance that owns it, which
  is the pin the map's **Pinned** chip reads.
- **`unread`** moves the thread's seen watermark: to its last update for
  read, one tick behind it for unread (`threadSeenWatermark`). Unread is
  "updated after the watermark", so a read mark that sends no watermark
  leaves the old one standing — the map's own **Mark as seen** did exactly
  that until this change, and the cookie came back on the next snapshot.
  Pin and read state share `thread.control.organize`, which Power User
  holds, and on a peer they need only its `thread_navigation` grant.

Local archives, pins and read marks go through the app's own paths
(`setAgentThreadActions`), so every window redraws from the same events a
click publishes.

Neither archiving nor moving will act on the thread running the call: it
would pull that thread out from under the turn that has to report the result.

## How the manager gets its instructions

Through an `AGENTS.md` in its own workspace
(`~/.pwragent/profiles/<profile>/star-map-manager/`), rewritten on every open so
an upgraded persona reaches an existing manager thread.

**Not** through the thread's `agent` metadata. That metadata marks a thread as
a persona thread for search and the Agents browser, and nothing in the app
injects it into a turn — `star-map-manager-thread.ts` sets it too, but only so
the thread is *marked* correctly. Every backend PwrAgent supports reads
`AGENTS.md` from its cwd, which makes it the one delivery mechanism that works
for all of them.

## Identity and lifecycle

`star_map_manager_thread` in the state DB's meta table remembers which thread
the button reopens. It is written when the manager is created and when the
operator resets it — not per turn, so it needs no write budget.

Before reopening, the remembered thread is checked against the navigation
snapshot: a thread that was archived is replaced rather than reopened into an
empty card. If that *check itself* fails, the remembered thread is kept —
reopening a stale card is recoverable, quietly minting a second manager on
every transient failure is not.
