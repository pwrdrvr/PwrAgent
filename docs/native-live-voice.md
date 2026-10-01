# Native live voice

Opt-in experimental voice runs on Codex `thread/realtime/start`. It has two
modes. Both use the same realtime session, and only one session runs at a time.

## Thread voice

Thread voice talks to one local Codex coding thread. The **Voice** mic toggle in
that thread's composer starts it. While it runs, a bar docked above the composer
shows an accent **Microphone live** state with a level meter, the session
clock, the last line spoken, the microphone toggle, **Transcript**, and **End
voice**. **Transcript** opens the
running transcript, tool receipts, and a **Message voice** field that appends
typed text to the voice conversation. Typing in the normal composer still uses
the ordinary coding flow. **Stop** remains the coding-turn interrupt and keeps
its name on every thread.

Leaving the thread ends its voice. A failed stop stays visible on the composer
the window lands on, so **End voice** can be retried there.

Thread voice runs on this machine's Codex App Server, and its handoffs run
turns in that thread, so it opens only on a local Codex thread. Everywhere else
the composer's **Voice** mic starts director voice instead, and its tooltip says
what that will do:

- On a new-thread launchpad, say what the thread should do. Director voice
  creates the thread in that project, on the launchpad's machine, with the
  settings the composer shows. Those settings are the launchpad's saved draft,
  which `create_instance_thread` applies.
- On a peer's thread, or a thread on another provider, director voice talks to
  that thread through the thread tools.

## Director voice

Director voice runs across threads and machines. The **Director voice** mic
starts it, as does ⌘⇧Space (Ctrl+Shift+Space on Windows and Linux). The mic sits
first in the window actions: in the sidebar masthead, in the thread header's
copy of those actions when the sidebar is hidden, and in the title bar on
Windows and Linux. Federation windows do not show it, and they do not accept
the shortcut. Hovering or focusing the mic opens a card with the shortcut and
example requests: summarize the threads that need attention, start a thread in
a project on another machine, tell the thread on screen to do something, or ask
what a thread on another machine is doing.

Director voice talks to the **Voice manager** thread, which is a Codex thread
that PwrAgent creates once and remembers. Like the Star Map manager, it is an
ordinary thread in a PwrAgent-owned workspace (`voice-manager` in the profile).
PwrAgent rewrites its `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `QWEN.md`
whenever the thread opens. If the remembered thread was archived, PwrAgent
makes a new one. Main gives the director prompt only to that thread.

Director voice starts without Codex's startup context
(`includeStartupContext: false`). That context summarizes the thread's recent
turns for the realtime model. On the Voice manager, the last turn is the
operator's previous request, and the realtime model answered it again as soon
as the session opened. The rest of the context maps the manager's empty
workspace. Thread voice keeps the context, because there it describes the
coding work the operator wants to discuss.

Director voice does its work through the PwrAgent dynamic tools. It uses
`list_attention_threads` to summarize what needs the operator on every
connected machine: running turns, unread threads, and threads waiting on input.
It uses `search_threads` with an `instanceId` to find a thread on another
machine. It uses `send_message_to_thread` and `steer_thread` to direct it, and
`stop_thread` only after the operator confirms. It starts every new
thread, local or remote, with `list_federation_instances`,
`list_instance_projects`, and `create_instance_thread`, and takes a named
provider and model from the backends `list_instance_projects` reports. It never
uses `handoff_task`: that tool can ask the operator to trust a directory, and
the question would wait on the Voice manager thread, which the operator does
not read. The Voice manager runs with Token Miser off. Its turns are short tool
chains whose results it needs at once, so paging output out only adds round
trips while the operator waits for a spoken answer. The realtime model delegates to the Voice manager's Codex turn. That
turn calls the tools, so thread and tool policies and federation RBAC apply as
usual.

To resolve "this thread", the Voice manager calls `read_operator_focus`. This
is a star map family tool and needs the same `tools.thread_inspection`
permission. It returns what the operator's local main window shows: the view,
the lens, and the selected thread with its backend, id, title, and instance.
With no thread selected, it reports an open new-thread launchpad instead: the
project key and label, the peer instance it will start on, and the composer's
backend, model, effort, execution mode and work mode. It never reports the
draft text. It also returns how long ago the window published that. Each local main window
publishes its focus 150 ms after a change, and again when it gains focus. Main
keeps the latest snapshot in memory only and accepts it only from local main
windows. When no window has published, the tool returns `focus_not_published`,
and the manager asks the operator which thread they mean.

Director voice shows in a floating panel. Drag the header to
move the panel. Drag the corner grip, or focus the grip and use the arrow keys,
to resize it. It opens at the top right, clear of the notice stack in the
bottom-left corner. The window remembers the panel's position and size, and
keeps the panel on screen and below the title strip. The panel sits over Settings
and under the notice stack.

The panel shows:

- a header with the title, the session clock, the microphone toggle, copy, and
  **End director voice**, which ends the session and closes the panel;
- the state on its own row: **Microphone live** with the level meter, **Muted ·
  ends 30s after the reply**, or the connecting, ending, and ended states;
- the thread or launchpad the window is looking at;
- the transcript with its receipts, and **Message voice**.

The header holds only items whose width does not change with the state, so it
fits the panel's 300px minimum width in every state. The state labels differ
widely in width; on the header row, the muted label wrapped the title and,
below about 380px, pushed the controls off the panel. Only the muted detail
yields, by ellipsis.

The panel outlives a session that ends on its own: muted after its reply, closed
by the service, or failed. It keeps the transcript and stops the clock at the
session's length. The state reads **Ended after the reply** or **Voice ended**.
The mic button becomes **Start director voice**, and the close button becomes
**Close director voice**. Starting again clears the old transcript.

The panel also shows any question that the Voice manager's turn is waiting on.
A tool can ask the operator something on the thread it runs in, and nobody
reads the Voice manager thread. A questionnaire, such as a directory to trust,
is answered in the panel. An approval offers **Open Voice manager** instead.
A question still pending from an earlier session appears when the panel opens.

Director voice continues across navigation. While it runs, the composer
**Voice** toggle is unavailable and its tooltip explains why.

### Session clock and muting

Both modes show how long the session has been live, in the turn timer's
format: `45s`, `1m 06s`, `1h 2m 3s`. That is the time the realtime session has
been open.

The microphone toggle is the masthead mic's button. The button is accented
while the microphone is live and shows a slashed mic while it is muted.

Muting never interrupts a reply. The microphone sends silence, so the voice
model hears no new speech and finishes its answer. A muted session then ends
itself 30 seconds after it goes quiet (`MUTED_IDLE_END_MS`). It is quiet when
no line is streaming and no turn is running on its thread. A tool receipt, a
typed message, or the start of a turn restarts the countdown. Unmuting cancels
it. A turn already running when thread voice starts counts as running.

A muted session that stays busy still ends 10 minutes after its last speech,
receipt or turn change (`MUTED_STALL_END_MS`). That covers a turn that runs
for hours, a turn blocked on a question, and a reply whose last line never
reports done.

So "ask, mute, listen" plays the whole answer, including a delegated turn's
result, and the session does not stay open afterwards. When this happens to
thread voice, an ordinary notice says that voice ended after its reply. The
director panel says so itself and stays open. Main logs `native voice session
stopped` once `thread/realtime/stop` returns. The voice manager or
coding turn itself is billed as usual, whatever the microphone does.

A voice failure in either mode is an ordinary app notice titled **Live voice**,
raised through the notice library. The voice controls clear as the notice
appears. The notice stays until it is closed or the next voice start begins.

Each dynamic tool call that the voice session's thread makes becomes a receipt.
A receipt names the tool, the target thread and machine when the result names
them, and the outcome. Main observes the calls at the registry's dynamic tool
chokepoint after each call settles. It reports only what the tool returned.

## Protocol and trust boundary

The desktop pins `@pwrdrvr/codex-app-server-protocol` 0.159.2. The capability
check requires Codex 0.159 or newer. It reads the version the way the protocol
gate does: the App Server's user agent leads with the client's name and then
Codex's version (`pwragent-desktop/0.159.0-pwragent.1 ...`), so the check must
not look for a `codex` token. A build suffix counts as its upstream version.
Version dispatch is a preliminary gate; actual account, workspace and service
rollout access are verified by starting the session and receiving its events.
Unsupported versions and asynchronous service errors appear in the voice
controls before microphone capture.

The verified managed runtime is `0.159.0-pwragent.1`. Explicit realtime `v3`
negotiates WebRTC successfully. Its default realtime version instead returned
`invalid_quicksilver_alpha_header` with `AVAS requires OpenAI-Alpha:
quicksilver=v2.` The slice consequently requests `v3` explicitly. It does not
silently downgrade or use a websocket audio fallback: the negotiated runtime
supports WebRTC, including browser-managed audio buffering and echo cancellation.
No PCM relay, separate API key or private realtime SDK is needed.

The renderer creates the peer, its audio transceiver, events data channel and
SDP offer. Narrow typed IPC sends only the offer and local session/thread
identities to main. Main negotiates through the existing initialized App Server
connection. No credentials, service URLs or direct service request API cross
IPC. Audio travels on the negotiated peer. Text/status/error events use the
Codex realtime notification fields. No code reads Codex-owned storage files.

Idle threads are prepared with the existing PwrAgent dynamic tool catalog,
current workspace/environment overrides, and selected model settings through
the registry's tool-refresh admission path. Resume rejoining a loaded thread
preserves its previous model and effort, so preparation also acknowledges
`thread/settings/update` before realtime starts. A bounded runtime probe verified
the loaded thread changed from its prior model/effort to the requested values.
Environment override serialization is covered by protocol tests; live shell
environment execution was not established by the bounded diagnostic probes.
Active coding threads retain their
current catalog and selected backend. Automatic Codex handoffs remain enabled.
Voice leases prevent a managed-runtime update from restarting the backend while
voice is live; queued typed input is released after catalog preparation without
removing a reservation owned by a coding start. Releasing the final voice lease
wakes any deferred invalid-ID recovery. Existing
thread/tool execution policies continue to apply. No new orchestration model,
calendar, email or personal administration capability is introduced.

## Ownership and cleanup

Main admits one voice session for the backend process across all windows. Every
control is scoped to its owning web contents and local session ID. A stop during
startup waits for the startup RPC to settle, then stops the accepted session
before admitting a replacement. Failed stop RPCs retain ownership and offer a
retry instead of allowing a potentially overlapping session.

The window owns the voice controller. The composer and the director panel
subscribe to its state. A thread change or composer unmount stops thread voice's
local media immediately. Director voice is not tied to a composer. If backend stop fails,
the window retains the original session token and exposes **End voice** retry
on the replacement composer, including a non-Codex thread, until stop is
acknowledged. The window also observes page teardown independently of composer
mounts. The browser owns tracks, remote playback, peer, ICE/connection timers and
event subscriptions. Microphone capture begins only after the service accepts startup,
emits `started`, and the peer connects. Stop, permission denial, late permission
results, startup failure, connection loss, thread change and window teardown
clean these resources. Main also watches navigation, renderer crashes, window
destruction and backend disconnect. Electron grants audio capture only to the
opted-in, established voice owner, and rejects camera/subframe media requests.
macOS packaging includes its microphone purpose string and audio-input
entitlement.

Speaking interrupts the negotiated voice conversation through its native audio
path. There is no client-side `turn/interrupt` in voice teardown. Closing voice
also disables transcript-tail task dispatch. Explicit task cancellation remains
a separate composer action.

Voice text uses a separate input and an explicit button rather than a nested
form. Enter is consumed by that input, so sending voice text cannot submit an
unsent coding draft or a configured review.

Voice transcripts are bounded, memory-only UI state. They are cleared for the
next session and are not added to PwrAgent persistence or federation traffic.
Codex may retain its own canonical conversation according to its protocol.

## Validation

Focused tests cover version gating, protocol fields, ordinary-notification
isolation, active-thread catalog inheritance, idle-thread refresh, cross-window
ownership, duplicate starts, stop during startup, startup/service failure,
backend loss, permission gating/denial, late capture results, establishment
expiry, stale events, local audio cleanup and failed-stop retries. They also
cover the mode prompts, the director gate, the Voice manager's identity,
`read_operator_focus`, focus and open-manager sender checks, receipts, mute,
and director voice surviving navigation.

Run the feature and affected backend suites from the repository root:

```sh
pnpm test apps/desktop/src/main/__tests__/codex-client.test.ts apps/desktop/src/main/__tests__/backend-registry.test.ts apps/desktop/src/main/__tests__/native-voice-session.test.ts apps/desktop/src/main/__tests__/native-voice-ipc.test.ts apps/desktop/src/main/__tests__/voice-manager-thread.test.ts apps/desktop/src/main/__tests__/star-map-agent-tools.test.ts apps/desktop/src/renderer/src/features/native-voice
pnpm lint:eslint
pnpm typecheck
pnpm lint:codex-storage
pnpm lint:colors
pnpm lint:boundaries
pnpm --filter @pwragent/desktop build
```

A short live probe used the existing authenticated managed App Server, an
isolated ephemeral thread and synthetic generic speech. WebRTC connected;
nonzero audio energy and packets arrived; user/assistant transcript events
arrived; Codex delegated a coding turn, invoked the existing
`pwragent.get_thread_status` schema/router, received a successful protocol-backed
result, and completed its turn. A second controlled probe stopped voice while
the coding tool response was pending: protocol status remained `active`, and
the coding turn completed after its successful tool response. No physical
microphone, unrelated account or
credit purchase was used. Raw probe logs/audio remain ignored under `.local/`.
A headless browser preview also exercised the actual voice component with
contrived transcript data and synthetic tracks: zero initial capture, one opted-in
capture, text append, then session stop.

This is an experimental slice, not a claim of broad plan entitlement or
production latency. Physical-microphone, signed-package and headed Electron
validation remain separate from the synthetic protocol/browser checks. The
current implementation uses the default input/output device and default voice;
it does not add a voice/device picker, voice in federation windows,
reconnection, session resumption, or short-lived planner threads. Director voice
reaches other machines only through the federated thread tools. A connection loss ends voice and
requires a new explicit start.

Official context: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice), and
[GPT-Live](https://developers.openai.com/api/docs/guides/live).
Desktop voice availability/pricing statements do not establish terms for this
external experimental App Server integration.
