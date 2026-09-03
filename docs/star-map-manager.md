# Star Map Manager and the Star Map Agent Tools

The Star Map's **Manager** button opens a long-lived thread the operator talks
to *about the map*: "rename that thread to have an AB test prefix like the
others in its cloud", "steer the two selected cards", "what is Studio actually
working on".

Nothing about the manager is a privileged execution path. It is an ordinary
thread with the ordinary PwrAgent tool catalog — `mutate_thread`, the
orchestration tools, the federation tools — plus one new tool that lets *any*
thread see what is on the map. The feature is really that tool; the manager is
the affordance that makes it worth having.

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

## The tool

| Tool | Serves | Messaging RBAC |
|---|---|---|
| `read_star_map_view` | Instances, clouds and their full membership, drawn vs folded cards, selection, open chat cards, camera, filters, and where each drawn card sits. Each thread carries `backend` / `threadId` / `instanceId`. | `tools.thread_inspection` |

It is gated for messaging-originated turns at the same permission as any other
read of thread metadata.

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
