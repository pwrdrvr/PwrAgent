# Personal mobile remote

Decision: Expo/React Native development builds, first targeting the owner's iPhone,
with the same TypeScript UI and WebRTC transport on Android. Build locally with
Xcode and the owner's signing identity. No EAS account, cloud build, store
submission, or paid session is required for development. JavaScript edits reload
from Metro over LAN; native dependency changes require rebuilding the development
client. Standalone Release builds bundle JavaScript for use away from Metro.

SwiftUI would simplify native audio and signing but require a second Android UI.
A WebView would reuse a web UI, but PwrAgent currently has an Electron renderer
with privileged IPC rather than a mobile web application. A native RN client
keeps that boundary and makes the requested LAN iteration practical.

OpenClaw was inspected read-only at the user-requested checkout. Its iOS
`Sources/Web/AuthenticatedControlUIWebView.swift` and Android
`ui/ControlUiWebView.kt` implement native-authenticated WebViews within
SwiftUI/Compose apps. It is not evidence of React Native. No source or assets
were copied.

## Gateway boundary

A separate opt-in HTTPS listener lives in the existing desktop gateway process.
It delegates bounded thread pages and replay reads to current owner-side
navigation and Federation APIs. The default list queries every granted machine,
with optional machine filtering. Each owner has its own continuation cursor and
error; one unavailable peer does not hide other machines. Thread identity is
`[ownerInstanceId, backend, threadId]`, never threadId alone.

The operator creates a ten-minute single-use pairing code with explicit scopes
and machine grants. The gateway stores SHA-256 hashes of 256-bit random bearer
credentials. The phone stores its credential in Keychain/Android encrypted secure
storage, device-only and accessible while unlocked. TLS is mandatory, including
on LAN; install a trusted LAN certificate or use an existing trusted TLS endpoint.
Browser origins and cookie/query authentication are rejected. Revocation is
checked on every operation and periodically for established sockets. The listener
is disabled unless an operator supplies its profile-local configuration.

Reads never confer send authority. Live additionally requires send, voice and
all-machines grants: the existing director's tool catalog can reach every thread,
so it cannot safely be exposed to a narrower grant. No filesystem access or
full Federation peer identity is granted to the phone.

## Reliability

The mobile outbox persists UUID, original payload, creation time, canonical hash,
owner, ingress gateway and device identity before sending. A different intentional
identical-text message gets a new UUID. A lost acknowledgment or restart reuses
the original UUID/hash. Owner migration or pairing to a different ingress does
not automatically replay old requests. The gateway sibling owns durable receipt
storage and dispatch. The client uses `durable_turn_requests_v1`, submit and get;
unsupported peers are read-only. V1 queues new turns. Active steering additionally requires
`durable_steer_requests_v1` and the current replay turn ID. Its distinct operation
and expected turn are persisted and hashed; the server uses durable
`controlActiveTurn` without falling back to a new turn.

Receipt state remains separate from transcript projection. There is no synthetic
user message inserted into the transcript. Reconnect refreshes authoritative
pages, selected replay and receipts. An uncertain outcome never silently creates
a replacement request. Exactly-once provider execution is not claimed.

## GPT Live

Existing PwrAgent Live uses Codex App Server `thread/realtime/*` v3 with WebRTC,
not a new OpenAI REST integration. The phone creates an audio peer and sends SDP
to the authenticated gateway; the gateway acquires the existing voice backend
and director thread with actual PwrAgent tools. SDP answers, transcripts and
tool receipts return through the gateway. Audio uses the supported WebRTC media
transport. No long-lived vendor credential reaches the phone; media is not
proxied through a second audio decoder on the gateway. A future strict media
relay deployment would require a separately configured TURN/media relay.

Microphone activation is explicit. Background, disconnect, revocation and stop
close the microphone and gateway-owned session. The server enforces heartbeat
expiry and a ten-minute session lifetime. Live is not resumed automatically after
reconnect. Vendor session tests require the operator's current cost authorization;
mock signaling tests are not evidence of a paid live conversation.

## Sources verified

- [Expo local development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo local builds](https://docs.expo.dev/guides/local-app-overview/)
- [Microsoft App Center retirement](https://learn.microsoft.com/en-us/appcenter/retirement): hosted CodePush retired with App Center; do not base a new workflow on it.
- [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/): future distribution must satisfy current downloaded-code rules; LAN development reload is not a promise that arbitrary production OTA changes pass review.
- [OpenAI WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime)
- [OpenAI server controls](https://developers.openai.com/api/docs/guides/realtime-server-controls)

Operator setup documentation belongs in pwrdrvr/docs.pwragent.ai before broad
release. This record and the mobile README document contributor implementation
and local verification only.
