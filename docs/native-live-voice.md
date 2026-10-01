# Native live voice vertical slice

This opt-in experimental slice connects an existing local Codex coding thread
through `thread/realtime/start`. Select **Start voice** in its composer, allow
microphone access after negotiation, and speak. **End voice** closes the voice
session. **Stop** remains the existing coding-turn interrupt operation and keeps
its name on every thread. The idle composer shows only **Start voice**; while
voice is live, an accent **Microphone live** indicator replaces the hint text.
Typing in the normal composer continues to use the ordinary coding flow. The
small **Message voice** field appends text to the voice conversation.

## Protocol and trust boundary

The desktop pins `@pwrdrvr/codex-app-server-protocol` 0.159.2. The capability
check requires an App Server user agent identifying Codex 0.159 or newer.
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

The window owns the voice controller; composers subscribe to its state. A thread
change or composer unmount stops local media immediately. If backend stop fails,
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
expiry, stale events, local audio cleanup and failed-stop retries.

Run the feature and affected backend suites from the repository root:

```sh
pnpm test apps/desktop/src/main/__tests__/codex-client.test.ts apps/desktop/src/main/__tests__/backend-registry.test.ts apps/desktop/src/main/__tests__/native-voice-session.test.ts apps/desktop/src/main/__tests__/native-voice-ipc.test.ts apps/desktop/src/renderer/src/features/native-voice/__tests__/native-voice-controller.test.ts
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
it does not add a voice/device picker, federation voice, reconnection, session
resumption, or short-lived planner threads. A connection loss ends voice and
requires a new explicit start.

Official context: [Codex App Server](https://learn.chatgpt.com/docs/app-server),
[ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice), and
[GPT-Live](https://developers.openai.com/api/docs/guides/live).
Desktop voice availability/pricing statements do not establish terms for this
external experimental App Server integration.
