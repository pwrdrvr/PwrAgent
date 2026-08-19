# Star Map Manager and the Star Map Agent Tools

The Star Map's **Manager** button opens a long-lived thread the operator talks
to *about the map*: "rename that thread to have an AB test prefix like the
others in its cloud", "steer the two selected cards", "what is Studio actually
working on".

Nothing about the manager is a privileged execution path. It is an ordinary
thread with the ordinary PwrAgent tool catalog — `mutate_thread`, the
orchestration tools, the federation tools — plus two new tools that let *any*
thread see what is on the map. The feature is really those two tools; the
manager is the affordance that makes them worth having.

## Why a view snapshot exists at all

The map is drawn entirely in the renderer. Cloud membership, which cards are
folded behind a `+N more` chip, the marquee selection, the camera, and the
active filter chips exist nowhere else — the navigation snapshot knows about
threads, not about what the operator can see.

That is exactly what a request like "the others in its cloud" depends on. So
`StarMapScreen` publishes a `StarMapViewSnapshot` to the main process, and
`read_star_map_view` serves it.

**Push, not pull.** The main process cannot ask a renderer a question. The
alternative — reimplementing `star-map-clusters.ts` in main — would drift from
what is actually drawn, and the renderer boundary forbids importing it anyway.

**Memory only.** The snapshot turns over as fast as a card drags. Persisting it
would be precisely the per-frame write pattern the repository's SQLite write
budgets exist to catch. `star-map-view-registry.ts` keeps it in a `Map` keyed
by `WebContents.id` and drops an entry when its renderer is destroyed, so a
closed map reports nothing rather than its last frame.

**Throttled.** `useStarMapViewPublisher` publishes on a 750 ms trailing edge and
builds the snapshot *inside* the throttle — the builder walks every cloud and
thread, and the hook sits on the drag path. Callers pass a memoized input, not
a finished snapshot.

## The two tools

| Tool | Serves | Messaging RBAC |
|---|---|---|
| `read_star_map_view` | Instances, clouds and their full membership, drawn vs folded cards, selection, open chat cards, camera, filters. Each thread carries `backend` / `threadId` / `instanceId`. | `tools.thread_inspection` |
| `capture_star_map` | A PNG of the surface that published the current view. | `tools.instance_management` |

Both are gated for messaging-originated turns. The screenshot deliberately
costs the higher permission: a picture of the operator's screen is more than a
read of thread metadata, and a messaging-driven turn can relay whatever it sees
back to its channel.

Two honesty properties are pinned by tests and worth preserving:

- **Truncation is reported.** `maxThreads` shortens the thread list but never
  the clouds' own counts — a shortened list must not read as a smaller cloud,
  or "the others in this cloud" acts on the wrong set. Drawn cards survive
  truncation ahead of folded ones.
- **A text-only transport says so.** Image content reaches the model over MCP.
  Over Codex dynamic tools the capture succeeds and the result carries
  `imageUnavailableReason` instead, rather than handing the model measurements
  it might read as "I saw the map".

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
