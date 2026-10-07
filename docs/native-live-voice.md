# Native live voice

Opt-in experimental voice runs on Codex `thread/realtime/start`. It has two
backend modes. Only director voice has a visible start control. Both modes use
the same realtime session, and only one session runs at a time.

## Thread voice

Thread voice talks to one local Codex coding thread. Its composer mic is hidden
until a transcription-only path can fill the draft without starting agent work
or speaking an assistant reply. Composers on launchpads, peer threads, and other
providers also omit their director voice fallback mic. Start director voice from
the window actions or its keyboard shortcut instead.

The composer retains controls for an already-open thread voice session, including
a session whose stop failed. While it runs, a bar docked above the composer
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
turns in that thread. It is conversational voice, not composer dictation.
Director voice can create a thread from the focused launchpad's settings or
talk to a peer's thread or another provider through the thread tools.

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

- a header with the title, the session clock, the microphone toggle, the camera
  toggle, copy, and **Close director voice**, which ends a live session and
  closes the panel;
- the state on its own row: **Microphone live** with the level meter, **Muted ·
  ends 30s after the reply**, or the connecting, ending, and ended states, with
  **End** at the row's end. End stops the session and keeps the panel and its
  transcript;
- what the window is looking at, which is what "this" means to the voice:
  **Looking at: Sample thread**, or **Looking at: new thread in Sample
  project** on a launchpad. It follows the window live, so it is hidden once
  the session ends;
- the transcript, with the director's lines labeled **Director**, tool
  receipts, and a one-line receipt for each camera cue sent to the voice;
- the camera dock while camera cues are on;
- **Message director**.

Mute, End, and Close are three intents: mute stops the director hearing the
room, End stops the session and keeps the conversation, and Close ends a live
session and closes the panel.

The header holds only items whose width does not change with the state, so it
fits the panel's 300px minimum width in every state. The state labels differ
widely in width; on the header row, the muted label wrapped the title and,
below about 380px, pushed the controls off the panel. Only the muted detail
yields, by ellipsis.

The panel outlives a session that ends on its own: muted after its reply, closed
by the service, or failed. It keeps the transcript and stops the clock at the
session's length. The state reads **Ended after the reply** or **Voice ended**,
and End becomes **Start again** in the same place. The microphone and camera
toggles leave the header. Starting again clears the old transcript.

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
In a narrow panel a receipt wraps rather than shrinking its target. The
tool, machine, and outcome keep their width, so the target is the one item that
would otherwise be squeezed to an ellipsis. It ellipsizes only when it is wider
than a line by itself.

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
opted-in, established voice owner. Video additionally requires that owner's
separate camera opt-in; subframe and combined audio/video requests are rejected.
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

### Idle-thread admission

Stock Codex 0.160.0 supports dynamic tools at `thread/start` but does not
advertise the PwrAgent dynamic-tools refresh extension on `thread/resume`.
A freshly created thread can start voice with the exact catalog acknowledged
in the current App Server process. PwrAgent compares the serialized catalog,
workspace, environment and input policy, then awaits `thread/settings/update`
for the effective model, effort, service tier, approval and sandbox settings.
`thread/start` does not carry an effort field, so creation alone is insufficient
proof of the selected effort. The fresh director's generic discovery catalog
is sufficient; eager director tools optimize latency but do not add authority.

Owned realtime handoffs retain admitted catalog proof for another voice
session in the same process. An App Server reset, an unowned coding turn,
thread closure, catalog refresh, or local turn/review mutation revokes it.
Revocation precedes resume, even if settings or inference later fail.

The remembered Voice manager uses ordinary `thread/resume` on stock Codex
when current-process proof is unavailable. Codex restores the tools registered
at creation; PwrAgent awaits current model, effort, service tier, workspace,
approval and sandbox settings before opening voice. This preserves the
manager's thread and history across app restarts. With discovery enabled,
the registered `tool_search` bootstrap returns current PwrAgent definitions;
tool dispatch still checks live turn ownership and current permissions.
Resume does not replace the persisted catalog or establish proof that it
equals the current catalog. New wire tools or changed schemas can still need
a supported managed runtime's refresh extension. A manager with a custom
execution environment, or any other idle thread with unknown/drifted catalog
ownership, retains the verified-refresh requirement. Active coding threads
keep their existing catalog ownership path.

A separate local stock 0.160.0 process acknowledged an ephemeral
`thread/start` with a contrived dynamic tool and a subsequent
`thread/settings/update` with model, effort, approval and sandbox settings.
Its `server/capabilities/read` call returned an unsupported-method error.
This probe sent no inference, realtime or microphone request.

A second stock 0.160.0 probe used an isolated Codex home and a loopback
Responses fixture. After process exit, ordinary resume restored the exact
creation-time discovery schema in the next model request, and the settings
update was acknowledged. Both contrived turns completed. This probe used no
cloud inference, realtime session or microphone; a spoken session after an
app restart remains an operator validation step.

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


## Camera context integration

During a listening director session, the camera button beside the microphone
in the Director voice panel can opt into local camera cues. Capture belongs to the window's voice controller
and ends on camera opt-out, voice stop, navigation teardown, or failure.

The camera dock sits between the transcript and **Message director**, as a
sibling of the transcript rather than inside it, so the preview holds one place
while the transcript scrolls. Its bar shows model latency and completed
decisions per second. An idle `none` or `neutral` pick stays in the secondary
color, so the accent appears only when the camera sees something. The row whose
cue was just delivered shows **sent** for four seconds.

The panel's size picks the layout, through a container query. At
the default width the mirrored preview sits beside each question's top pick
(gesture, vibe, present) with its confidence. Dragged to about 470px wide and
800px tall, every option's meter for all three questions spans the dock below
the preview and picks, plus the filter status. From about 790px wide and 660px
tall, the meters move beside a larger preview, the way the Clef demo lays them
out. The preview keeps a 4:3 frame at every size, so extra width goes to the
meters instead of cropping the video to a strip. The height floors keep the
transcript readable; the panel is a size container, so both dimensions count.
Both readouts stay mounted, so a resize never restarts the video.
**Copy camera diagnostics** copies what the dock leaves off-screen: frame age,
stale-result count, acknowledgment counts, the latest repeat check, and the
owning thread and session.
Received results and acknowledged context are counted separately.

Each gesture or presence cue sent to the voice is also a transcript row
(camera · **stop** · sent), in order with the speech, so reading back answers
whether the voice was told. Vibe cues reach the voice too but are ambient, so
they appear only in the dock.
The row reads **sending…** until the context RPC acknowledges and **not
delivered** if it fails.
An appendText RPC acknowledgment confirms delivery to Codex, not whether the
realtime model incorporated the observation into its next answer.

### Decision model settings

Settings → AI Providers configures the decision model. **Defaults →
Decisions** picks it (the local decision model, TypeSafe Jev, or Off) and holds
the **Camera cues in live voice** switch. Off is the default: with nothing set
up, live voice has no camera button and none of the camera features below. Both providers speak TypeSafe's
[System One API](https://docs.typesafe.ai/api): `POST <base URL>/v1/systemone`
with `model`, `state` and typed `questions`. The Providers index lists both,
each with its own screen:

- **Local decision model**: the endpoint (default `http://127.0.0.1:8787`,
  PwrSuiteLab's Clef runtime), the model id (default `clef-flash`, the only id
  that runtime accepts), an optional API key sent as a bearer token, a
  connection test that confirms `GET /v1/models` lists the model and reads
  `/health` for load, and links to Cloudflare's Clef as the suggested model.
- **TypeSafe Jev**: the API key, the model id (default `jev-latest`), a
  connection test that asks one yes/no question, and links to the TypeSafe
  console and docs.

Camera frames go only to the local decision model, and the endpoint must be an
address on this Mac: `localhost`, `127.0.0.0/8` or `::1`, with no path. The
camera button appears only when the local decision model is chosen and the
switch is on; Jev takes text only, so choosing it hides the button too. A
session reads this when it starts, and main re-reads the
setting before every frame, so turning cues off mid-session stops the next
frame; the local API key is read once, when the camera turns on.

The keys are stored in `[models.decision]` (`model`, `camera_cues`,
`local_endpoint`, `local_model`, `jev_model`); the API keys are secrets, never
config.

### Frames and questions

Main sends 336-pixel JPEG frames to the local decision model's
`/v1/systemone`, as a data URL in `images`: Clef's extension to the System One
request, which takes up to four inline images. The questions are short
demo-style ones for gestures, boolean
presence and vibe. Gestures include pointing, OK, stop, thumbs-up, double
thumbs-up, thumbs-down, facepalm and none. Vibe includes neutral, exasperated,
frustrated, yelling and talking. All 15 returned scores
are shown in the camera dock at wide panel widths. The state is the demo’s compact
“A live webcam frame from a laptop.”, with no instruction to favor neutral. One request
runs at a time, at up to two frames per second. System One responses carry no
timing, so the latency the dock shows is main's round trip. A request the
server refuses (HTTP 4xx other than 408 or 429, such as a model id it does not
serve) stops camera cues with the server's reason, since every later frame
would be refused the same way. Camera permissions and frame
requests require the owning, established voice session and a separate camera
opt-in. Frames and decisions remain in memory; this integration adds no
PwrAgent SQLite writes or image files.

The local preview shows "warming up" until the first valid decision. That
request has a five-minute deadline and waits for one response at a time,
retrying connection failures and temporary HTTP 429/5xx responses after a
one-second pause. Opt-out, voice stop and backend closure abort both the
request and retry pause immediately. Intentional cancellation resolves without
a Clef-unavailable error. Main logs first-decision waiting/completion, real
failures, cancellations, and context RPC acknowledgments; it never logs frames
or raw Clef responses. After the first decision, ordinary
inference retains its eight-second deadline. After that, a Clef failure skips
the frame, not the camera. Clef serializes requests, so a warm model that
misses the deadline is usually serving another client, such as a benchmark
(**cue model busy**); one that refuses the connection may be restarting
(**cue model offline**). The preview stays up with that caption in place of
the stale reading, the skipped frame resets continuity so it never completes a
gesture or counts as absence, and the next frame waits 2s, doubling to 16s,
because an abandoned request still runs to completion inside Clef. The first
result after a skip resumes normal sampling. After a missed deadline, the
next frame first asks the PwrSuiteLab Clef runtime's `GET /health` for
`requests_processing`, which it answers without the model lock and which counts
the abandoned request. While that is above zero no frame is sent; the dock
reads **busy · N in flight** and asks again each second. A server without the
route falls back to the backoff. Responses to frames older than ten seconds are
discarded and reset continuity; model-loading time cannot count as absence.

The filter requires presence confidence of at least 80% and reaction
confidence of at least 70%, three consecutive samples spanning 1.5 seconds,
and an eight-second cooldown between reaction changes. Repeated cues are
suppressed after the first sustained cue, including initial neutral context.
Uncertain presence, a visible return, or a ten-second sampling
gap resets the absence countdown. Ordinary gestures require 80% confidence
and three samples spanning 1.5 seconds; stop and thumbs-down require 85% and
two consecutive frames spanning 500ms, bypassing ordinary cue cooldowns.
Gestures require confident presence, and stale frames never establish a cue.
Thirty seconds of confident absence ends
voice, leaving coding turns running.

### Repeated gestures and the conversation

A cue the voice has already answered is noise. If the operator holds a stop
after the voice says "Okay, pausing.", or makes it again, the voice gains
nothing from a second stop. A stop after the voice changes course is new
feedback. Telling the two apart takes the conversation, so the decision step
reads it.

- **Deterministic gate (filter).** The filter remembers the last gesture it
  sent and the number of lines the voice had finished saying at that moment.
  Tool actions do not count. The same gesture, held or made
  again, is not even considered until that count moves. Dropping the hand no
  longer re-arms it. A confirmed away clears the record, so a gesture after
  the operator returns is new. Ordinary gestures keep their eight-second
  cooldown, and the cooldown applies before Clef is asked.
- **Conversation check (Clef).** Once the voice has finished a line since,
  the controller asks Clef one yes/no question about the conversation since
  the latest camera cue. The question asks whether the voice said anything
  beyond acknowledging the cue. A yes (probability of 0.5 or more) sends the
  gesture again. A no records the current count, so the same acknowledgment
  is never judged twice. Asking costs at most one check per voice line, never
  one per frame. If Clef is busy, offline or unavailable in the window, the
  repeat is held, because the noise is what the check prevents. An
  unanswered check waits two seconds, or as long as main asks while Clef is
  contended, before it is asked again. The check is an extra request on top
  of the frames, so main asks `/health` before every check and skips it while
  any decision is in flight. A check that misses its deadline also makes the
  next frame ask `/health` first.

The check's `state` is a bounded excerpt of the last 90 seconds, at most 12
rows. It holds operator and voice lines, voice tool actions, and the cues
handed to the voice (failed ones excluded). Each row has a negative relative
timestamp, oldest first:

```text
Voice conversation, oldest first, in seconds before now:
-37s operator: Make every cloud in the scene pink.
-30s voice: Sure, I'll turn every cloud pink and soften the edges.
-11s camera cue: stop (delivered)
-9s voice: Okay, pausing.
```

Rows carry their start time in memory only, for this excerpt. Each line's
whitespace is collapsed, so spoken text cannot start a row of its own, and
each line is clipped to 240 characters. Main revalidates the excerpt's shape
and never logs it. The excerpt is built on demand and never stored.

The check is its own request, never part of a frame's request. Clef decides
all of a request's questions jointly, and a transcript in the frame's `state`
moved the frame's own answers. On a photo with no person in it, adding a
conversation that mentioned a stop cue raised "stop" from 0.21 to 0.50 and
"present" from 0.42 to 0.71. Rewording the frame questions, or leaving the
word "stop" out of the excerpt, still left "stop" at 0.44 to 0.53. The check
is text only, with no `images`. Every camera request body comes from
`cameraDecisionRequest` in `clef-camera.ts`. A refusal (a 4xx other than 408
or 429) stops camera cues, as it does for a frame. A timeout or an
unreachable model holds the repeat.

The question's wording was chosen against ten probe conversations. It answered
all ten correctly, both alongside a blank image and text only through
`/v1/systemone`. The text-only scores:

| Conversation after the cue | Moved on |
|---|---|
| nothing | 0.06 |
| "Okay, pausing." | 0.04 |
| "Oops, I'll stop." | 0.08 |
| "Okay, stopping. What would you like instead?" | 0.33 |
| "Paused. Let me know when you want me to continue." | 0.03 |
| substantive line spoken before the cue, acknowledgment after | 0.04 |
| ack, then "deleting all the whipped cream off every apple pie instead" | 0.96 |
| the new plan alone | 0.95 |
| ack, then resuming the old plan | 0.88 |
| ack, then answering a new operator question | 0.76 |

A voice tool action after the acknowledgment scored 0.13 to 0.46 across three
phrasings (measured with the blank image), so an action alone does not re-arm a gesture. That is
defensible: a `stop_turn` right after a stop cue is the voice acting on it.
Actions therefore do not open the gate. They appear in the excerpt only as
context, and only something the voice says re-arms the gesture.

The first wording tried ("did the voice say something new?") scored the ack
plus a question at 0.94. The closest bare acknowledgment is still the ack plus
a question, at 0.33. A voice answering an unrelated new question counts as new
feedback, which errs toward sending the gesture.

Latency, measured against the lab's clef-flash on an M5 Max with an idle GPU
and 20 runs per row. The joint rows went through the old `/decide` route,
whose `latency_ms` was model time. The System One rows are round trips.

| Request | Input tokens | p50 | p95 | Decisions/s |
|---|---|---|---|---|
| Frame, plain `state` (unchanged), `/decide` model time | 478 | 446 ms | 467 ms | 2.2 |
| Frame + 4-row conversation, joint (rejected) | 657 | 613 ms | 633 ms | 1.6 |
| Frame + 12-row conversation, joint (rejected) | 947 | 853 ms | 872 ms | 1.2 |
| Frame, plain `state`, `/v1/systemone` round trip | 478 | 445 ms | 538 ms | 2.2 |
| Repeat check, text only, 4 rows | 237 | 207 ms | 223 ms | on demand |
| Repeat check, text only, 12 long rows | 526 | 425 ms | 481 ms | on demand |

Frame sampling keeps its full rate. Only a repeat that has passed the gate
waits one check, about 0.2 to 0.5 seconds, before it is sent.

### Presence hysteresis

The filter remembers what the voice was last told about presence, across
skipped frames and continuity resets. Once away is reported, it is not
reported again while the operator stays gone. A glimpse too short to count as
a return does not reset it.

Reporting away takes three confident absent samples spanning 1.5 seconds.
Reporting a return takes four confident present samples spanning three
seconds. The return's frames also build the next vibe, so the return cue goes
out as soon as the return is confirmed. An operator half out of frame,
alternating 1.5-second runs, gets one away cue rather than one per run.

The 30-second end counts only sustained absence, as before. Any confident
sight of the operator, or an uncertain frame, restarts it, including before a
return is confirmed.

Camera observations are pushed automatically by the voice controller; there
is no model tool to poll for them. Only an allowlisted, debounced text cue
reaches GPT-Live, through Codex
`thread/realtime/appendText` with role `developer`. The prompt treats cues as
uncertain visible observations: exasperation asks for reconsideration,
enthusiasm develops the current direction, boredom asks for brevity or a
question, and absence informs the model the operator has left. Stop/no or
thumbs-down requests a pause and spoken clarification before another action.
The payload is explicitly labeled as uncertain camera context, never invented
spoken user text. This context RPC does not guarantee immediate audio
barge-in or cancellation of an already dispatched action. A camera cue cannot
approve or cancel
work. Before the first decision, a Clef failure stops camera capture and shows
a dismissible error while voice remains available. Facial-expression accuracy and the model's spoken
adaptation still need live evaluation by the operator.
