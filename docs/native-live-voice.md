# Native live voice

Opt-in experimental voice runs on Codex `thread/realtime/start`. It has two
modes. Both use the same realtime session, and only one session runs at a time.

## Thread voice

Thread voice talks to one local Codex coding thread. The **Voice** mic toggle in
that thread's composer starts it. While it runs, a bar docked above the composer
shows an accent **Microphone live** state with a level meter, the last line
spoken, **Mute**, **Transcript**, and **End voice**. **Transcript** opens the
running transcript, tool receipts, and a **Message voice** field that appends
typed text to the voice conversation. Typing in the normal composer still uses
the ordinary coding flow. **Stop** remains the coding-turn interrupt and keeps
its name on every thread.

Leaving the thread ends its voice. A failed stop stays visible on the composer
the window lands on, so **End voice** can be retried there.

Thread voice runs on this machine's Codex App Server. On a peer's thread, or a
thread on another provider, the toggle stays visible but disabled, and its
tooltip points to director voice, which can reach both.

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

Director voice does its work through the PwrAgent dynamic tools. It uses
`list_attention_threads` to summarize what needs the operator on every
connected machine: running turns, unread threads, and threads waiting on input.
It uses `search_threads` with an `instanceId` to find a thread on another
machine. It uses `send_message_to_thread` and `steer_thread` to direct it, and
`stop_thread` only after the operator confirms. It starts work on another
machine with `list_federation_instances`, `list_instance_projects`, and
`create_instance_thread`. The realtime model delegates to the Voice manager's Codex turn. That
turn calls the tools, so thread and tool policies and federation RBAC apply as
usual.

To resolve "this thread", the Voice manager calls `read_operator_focus`. This
is a star map family tool and needs the same `tools.thread_inspection`
permission. It returns what the operator's local main window shows: the view,
the lens, and the selected thread with its backend, id, title, and instance.
It also returns how long ago the window published that. Each local main window
publishes its focus 150 ms after a change, and again when it gains focus. Main
keeps the latest snapshot in memory only and accepts it only from local main
windows. When no window has published, the tool returns `focus_not_published`,
and the manager asks the operator which thread they mean.

A floating panel in the bottom-left corner shows the session. It has the live
state, **Mute**, **Hide**, **End voice**, and the thread the window is looking
at. It also shows the transcript, the receipts, and **Message voice**. Director
voice continues across navigation. While it runs, the composer **Voice** toggle
is unavailable and its tooltip explains why.

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
