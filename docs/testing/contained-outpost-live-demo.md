# Contained Outpost live validation

This run used the existing Docker Outpost on the M5 Max on 2026-11-10.
No new Outpost identity or volume was created. The shared `lock.d` was held
by thread `01a1c604-1f00-7a33-9e6a-e493a7f76ec3` during image replacement
and the demo, then released after restoring the original gateway pairing.

## Versions

| Component | Exact version |
| --- | --- |
| Main starting point | `a5cb66a97183bc5b4a09c11e8c89171a18083d03` |
| Desktop receiver and Outpost implementation exercised | `2d8a795b8d609c619dd170f2f51a2c97970eec7b` (SSH-signed) |
| Package / Codex / Node | `pwragent 1.3.16` / `codex-cli 0.159.2` / `v24.21.0` |
| Docker image | `pwragent-outpost:pwr137-2d8a795b` |
| Image ID | `sha256:f2236612161041e44fee9042bd31f227c1fd464fe593b8aa02c487da0ea4a8b0` |
| Existing Outpost identity | `4f9b407d-2bb9-4893-9b98-28b88952a3de` |
| Isolated desktop receiver | `pwr_57c0fdf7-9979-471c-9778-e11fb589833c` |

The Dockerfile, seccomp profile, volume, read-only authentication mount,
`--cap-drop ALL` and `no-new-privileges` were reused from the existing runbook.
The installed Outpost federation source matched the signed checkout byte for
byte. Codex retained its workspace-write sandbox and approval policy `never`.

## Receiver and guard refusals

The real desktop application ran from the implementation checkout with an
isolated PwrAgent root and loopback listener. A temporary, uncommitted startup
driver invoked its production `generateInvite`, `setPeerRole`, and
`remoteBackend` APIs; it introduced no replacement receiver or backend. The
original Outpost identity was temporarily enrolled there. The receiver assigned
`contained`, and the Outpost's authenticated role query confirmed it. The
negotiated session did not contain `gateway_relay`.

At 15:57:26 UTC, a probe using that same Outpost identity attempted both methods:

| Method | Actual Outpost transport | Actual desktop receiver with guard bypassed |
| --- | --- | --- |
| `backend.startThread` | `capability_denied: contained Outpost egress` | `capability_denied: Contained peer request is not allowed.` |
| `file.push.begin` | `capability_denied: contained Outpost egress` | `capability_denied: Contained peer request is not allowed.` |

The probe captured the raw transport sender before installing the production
Outpost transport wrapper. The guarded calls were refused before sending; the
raw calls then exercised the receiver independently. Both journals recorded
the peer ID, method, role and time. The desktop journal contained one refusal
for each forced request, with no request parameters. No blocked thread or file
was created.

## Normal task

After restarting the daemon and its existing relay, the desktop's real
`FederationRemoteBackendClient` created a thread and started a Codex turn on
the contained Outpost. A thread subscription delivered the terminal event.

| Fact | Evidence |
| --- | --- |
| Thread | `01a1c62d-b450-7180-ba9c-95914d2ea897` |
| Turn | `01a1c62d-b6ed-7d53-8e22-aa24643e0111` |
| Terminal status | `completed` |
| Provider-reported duration | `6301` ms |
| Transcript read completed | `2026-11-10T15:57:33.487Z` |
| File verified with `docker exec` | `/home/outpost/workspace/hello-world/pwr137-contained-demo.txt` |
| File and assistant reply | `PWR-137 contained Outpost real Codex PASS` |

The Outpost was then restored to its original Mac mini gateway
`pwr_3d822fab-1b7c-4f8e-9d5a-c765d818ad97`, through its saved
`ws://127.0.0.1:47833/` endpoint. Its original identity and both key pairs were
verified unchanged. It remains running the tested image, connected to that
gateway. The Mac mini application was not replaced; the Outpost's local guard
stays contained when an older receiver cannot report a role. The isolated
desktop was closed through the development-profile lifecycle script, and its
temporary startup hook was removed.

## Automated validation of the boundary

Generated properties fail against main's original router/policy, actual
desktop receiver and messaging admission. The original Outpost sender fails
the transport guard test. An exhaustive owner-method decision test fails when
any new method lacks a contained-role entry. The encrypted gateway suite
exercises every owner method with all capabilities advertised and checks each
refusal's audit entry. A three-peer test also runs a task and an inbound
operator file push on a contained Outpost.

Settings component tests exercise displaying and changing the role. Native
Computer Use and browser access were unavailable during the live run, so no
Settings screenshots were captured. The desktop Electron E2E suite was not
run on this Mac; CI owns that validation.
