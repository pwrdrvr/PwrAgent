# Tailscale Federation: Funnel admission and guided setup

Date: 2026-09-09. Status: research recommendation, not an implementation approval.
Code baseline: `ab922ad5f`, fetched `origin/main` in the assigned worktree.
Scope: official documentation research and current-code inspection only. No external
resources were provisioned, no live Tailscale configuration was read or changed,
and no endpoint probes were executed. Cloudflare onboarding is being implemented
separately; this record evaluates compatibility with its stated admission goal,
not the correctness of that implementation.

## Decision

Do not offer Tailscale Funnel as satisfying mandatory client mTLS admission at a
public edge. The documented relay architecture and CLI do not provide that gate.
Keep Cloudflare as the public-edge onboarding direction, conditional on its own
certificate-policy and no-forwarding tests passing. Prefer Tailscale Serve for a
guided private-network alternative. Direct Tailscale VPN connectivity remains
useful for existing network operators.

The decisive distinction is where rejection happens. Funnel relays encrypted
traffic to the device; ordinary HTTPS mode terminates TLS there. It does not
document a relay-side client certificate verifier or public caller allowlist.
The `funnel` node attribute authorizes publishing, not callers. This makes the
negative recommendation an inference from the documented architecture and
supported controls, rather than a claim about every possible future Tailscale
feature. [Funnel architecture](https://tailscale.com/docs/features/tailscale-funnel),
[Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel).

## Security boundaries

For this decision, **public edge** means the provider's internet-facing relay;
**device boundary** means the local Tailscale daemon or a local TLS proxy;
**origin** means PwrAgent's TCP/HTTP/WebSocket listener. “No origin forwarding”
requires zero connections to that listener for rejected remote clients, not just
zero authenticated federation sessions.

| Mode | Reachability and identity | Rejection boundary | Fit |
|---|---|---|---|
| Direct VPN | Tailnet connection to a bound federation port; network device identity plus PwrAgent identity | Receiving device's network policy, before application connection | Private option; not public-edge mTLS |
| Serve | Private proxy to loopback; tailnet access rules | Tailscale device boundary before proxying, if effective policy denies caller | Preferred guided private option |
| Ordinary Funnel | Public TLS proxy to loopback; no documented public-client identity admission | PwrAgent currently authenticates after WebSocket connection | Fails required public-edge gate |
| Funnel raw TCP plus local mTLS proxy | Public TLS bytes forwarded to an added local verifier | Local proxy before PwrAgent, but after relay-to-device forwarding | Possible different requirement, not edge parity |

Serve supplies user identity headers, stripping incoming spoofed values; tagged
devices do not receive those user headers. Newer app-capability headers can
represent tagged devices, but neither header facility is available for Funnel.
These are backend identity assertions, not a substitute for network admission.
Keep federation enrollment and pinned peer identity in every mode.
[Serve identity and capabilities](https://tailscale.com/docs/features/tailscale-serve).

Tailscale ACL enforcement occurs on the receiving device and does not protect
ordinary LAN traffic. Therefore a wildcard PwrAgent listener can have a LAN
bypass around tailnet policy. Prefer Serve with loopback binding; for direct VPN,
use a Tailscale-specific bind and verify other interfaces cannot reach the port.
Do not describe DERP-relayed VPN traffic as Funnel simply because it uses a relay.
[ACL enforcement](https://tailscale.com/docs/features/access-control/acls).

### Deny by default requires inspecting the effective policy

New tailnets start with an allow-all policy. Grants are additive: a narrow rule
cannot cancel an existing broad grant. A setup wizard must check all applicable
ACLs and grants, including sharing and tag ownership, before claiming that only
selected clients can connect. Merely adding `tag:pwragent-client` access to a
gateway tag is insufficient. [Default policy](https://tailscale.com/docs/reference/examples/acls),
[grant union semantics](https://tailscale.com/docs/reference/syntax/grants).

Proposed private setup policy: selected client devices may reach only the
gateway's selected TCP service port. All other sources must lack an applicable
allow rule. Use policy tests for allowed and denied identities. Do not rewrite a
shared tailnet's broad rules automatically: present the exact required policy
change or leave admission marked unverified. A separately managed network is a
larger deployment choice, not a fallback the wizard should silently create.

### Certificates and proposed local-proxy alternative

Funnel's automatic HTTPS certificate authenticates the server. It does not enroll
federation clients. Supplying `https://localhost:...` as the proxy target changes
the upstream connection; it does not add internet-client certificate admission.
The CLI documents raw TCP forwarding and TLS-terminated TCP forwarding, with no
client-CA or client-certificate allowlist option. [Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel).

If the requirement were explicitly relaxed to protecting only the PwrAgent
listener, an engineering experiment could use raw TCP Funnel to a local TLS
proxy that requires a trusted, authorized client certificate before opening an
upstream connection. This is a proposal, not a validated configuration. It adds
server-certificate renewal, client issuance, secure private-key storage,
per-client revocation, proxy packaging and process ownership. Reject missing,
expired, untrusted, revoked and trusted-but-unapproved certificates. A trusted CA
alone is insufficient if it also issues credentials to other clients. Never use
TLS-terminated forwarding for this experiment: the local verifier needs the
original TLS handshake. Even a successful prototype would still forward hostile
handshake bytes to the device, so it cannot satisfy public-edge rejection.

## Current PwrAgent implementation

Evidence below is from current source at the baseline, not historical plans.

| Source | Observed behavior and implication |
|---|---|
| [federation-tailscale.ts](../../apps/desktop/src/main/federation/federation-tailscale.ts) | Discovers CLI via PATH and the macOS app executable; reads `status --json --peers=false` and `serve status --json`; exposes a small sanitized status model. |
| Same service, `configure` | Validates mode/port, requires connected Tailscale, verifies runtime loopback listen URL, then invokes mode with `--bg --yes --set-path=/pwragent-federation` and an HTTP loopback target. No policy admission check, ownership journal, rollback or cleanup operation. |
| Same service, status helpers | Any handler at the path counts as configured; exact proxy target, host, port and handler type are not checked. Funnel uses `AllowFunnel[hostPort]`. URL construction always assumes default port 443. A handler on another port can therefore produce an incorrect URL. |
| [FederationSettings.tsx](../../apps/desktop/src/renderer/src/features/settings/FederationSettings.tsx), `configureTailscale` | Writes gateway/dual loopback configuration, checks listener health, invokes setup, then writes public URL. A URL-save failure explicitly leaves Tailscale configured. No compensating transaction is present. |
| Same Settings component | Funnel requires a public-exposure checkbox in the UI. The service request has no equivalent acknowledgement field. Status badges describe configuration, not tested admission or reachability. The dedicated-path explanation omits port-wide exposure effects. |
| [federation-transport.ts](../../apps/desktop/src/main/federation/federation-transport.ts), `start` and `handleSocket` | Creates an HTTP server and attached WebSocket server. The connection event starts Noise and federation authentication. A rejected unknown peer has already reached origin. |
| [federation-runtime.ts](../../apps/desktop/src/main/federation/federation-runtime.ts), gateway construction | Supplies Noise static keys in the current runtime, preserving inner encryption independently of the proxy. This does not move admission ahead of origin. |
| [federation-advertised-endpoints.ts](../../apps/desktop/src/main/federation/federation-advertised-endpoints.ts) | Can synthesize direct tailnet DNS candidates for wildcard listeners, and proxy URLs when configured. Loopback setup relies on the saved public URL. Candidates carry reachability hints, not proof of policy enforcement. |
| [federation-tailscale.test.ts](../../apps/desktop/src/main/__tests__/federation-tailscale.test.ts) | Mocked CLI tests cover status sanitization, private/public flags, setup arguments and listener failures. They cannot establish actual public reachability or absence of origin forwarding. |

Three concrete findings deserve independent fixes if implementation is approved:

1. A dedicated HTTP path does not isolate the port's exposure mode. Official docs
   state that switching between Serve and Funnel makes the whole port private or
   public. Existing unrelated handlers therefore need conflict detection before
   mutation. [Port scope](https://tailscale.com/docs/features/tailscale-funnel).
2. “Serve configured” currently also means a handler exists on a Funnel-enabled
   port. Model handler presence and private/public exposure separately; a private
   setup must require Funnel disabled on its authority.
3. [The connectivity reference](../federation-connectivity-reference.md) says
   path-scoped removal is unavailable. Current official CLI docs show
   `tailscale funnel --https=443 --set-path=/foo off`. Treat the local text as
   stale; validate installed-version behavior and sibling preservation before
   shipping automated cleanup. [Documented removal](https://tailscale.com/docs/reference/tailscale-cli/funnel).

## How polished can setup be?

### Existing Tailscale installation: good guided experience is feasible

Proposed screens/states: detect installation → connect account → inspect policy
and route conflicts → establish loopback listener → configure private Serve →
verify from an allowed and denied peer → publish the invite. Explain a concrete
next action for logged-out, needs-admin, incompatible CLI and unreachable cases.
Do not collapse these into “Run it in Terminal for details.” Login and initial
installation still belong to Tailscale and the operating system.

Funnel has a browser approval step for initial enablement. Its documented
prerequisites include MagicDNS, HTTPS and publishing permission; supported public
ports are 443, 8443 and 10000. It uses tailnet DNS names, remains beta, and has
non-configurable bandwidth limits. Documentation on the same page conflicts about
macOS variants: requirements say open-source variants, later text permits port
sharing with App Store/Standalone variants. Test actual supported variants rather
than hard-code either statement. [Funnel setup](https://tailscale.com/docs/features/tailscale-funnel).

The existing 15-second synchronous command timeout is unsuitable for a person
finishing browser approval. Proposal: separate prerequisite discovery from route
mutation, capture only a validated Tailscale approval URL, offer Open Tailscale,
and resume from explicit status refresh. Persisted “configured” must never mean
“we displayed a URL.” Do not retry mutations blindly after a timeout.

### Full provisioning: possible pieces, substantial ownership expansion

Auth keys support noninteractive node enrollment. OAuth clients provide scoped
API credentials, including the ability to mint auth keys. This is useful for
managed deployments, but requires operator-created credentials and a secrets
lifecycle. It is not a built-in public-client authentication feature for Funnel.
[Auth keys](https://tailscale.com/docs/features/access-control/auth-keys),
[OAuth clients](https://tailscale.com/docs/features/oauth-clients).

Current OAuth **apps** offer user consent and user-owned device provisioning, but
are alpha, require an Owner/Admin-created app, and restrict app and consenting
users to the same tailnet. Thus a universal PwrAgent “Connect any Tailscale
account” button is not supported by this documented mechanism.
[OAuth apps](https://tailscale.com/docs/features/oauth-apps).

The August 2026 Tailnets API can create/list/delete API-only tailnets; it is alpha,
requires an OAuth client in an existing tailnet, supports tagged devices only,
and allows ten total organization tailnets before a sales contract is needed.
These networks have no human users/admin-console presence. This opens a future
embedded private-connectivity design, not a bounded improvement to today's
desktop CLI flow. [Tailnets API](https://tailscale.com/docs/features/tailnets-api).

Recommend no credential ingestion or embedded daemon in the first iteration.
If later approved, use least-privilege scoped credentials, protected local secret
storage, redacted diagnostics, and explicit ownership of created devices and
policies. Do not ship a reusable organization secret in the application.

## Endpoint-security acceptance specification

These are proposed tests, not results. Run in an authorized isolated fixture
environment with a truly separate internet vantage point and three identities:
allowed tailnet device, denied tailnet device, and non-tailnet internet client.
Do not rely on a same-machine or same-egress request to prove public behavior.
The repository's existing connectivity reference records incomplete historical
off-tailnet Funnel validation; it is not a passing result for this decision.

Instrument the origin before WebSocket authentication: count TCP accepts, HTTP
requests/upgrades and federation auth starts in memory. Assign each attempt a
unique nonce and isolated time window; use capture at the loopback listener to
corroborate counts. Record route/policy fingerprints, selected DNS/IP, probe
vantage and timestamps. Keep positive controls immediately before and after
negative attempts so an outage cannot masquerade as successful admission.

| Probe | Required observation |
|---|---|
| Allowed Serve device, valid federation invite | Successful WebSocket, Noise and enrollment/RPC; nonzero origin counters prove instrumentation works. |
| Denied tailnet device, same Serve host and path | No origin TCP accept, request, upgrade or auth start. |
| Non-tailnet client against private Serve | No origin events; separately prove probe internet connectivity. DNS or timeout alone does not identify the rejection layer. |
| LAN client against raw federation port, IPv4 and applicable IPv6 | No origin connection for the loopback-only setup; detects bypass. |
| Allowed network device, invalid federation identity | Reaches origin but fails federation auth. Explicitly classify as inner authentication, not outer admission. |
| Ordinary Funnel, no certificate or federation identity | Expected origin reachability for a valid WebSocket upgrade; this demonstrates failure of the required gate, not an implementation regression. |
| Future mTLS edge integration: missing, untrusted, expired, revoked, trusted-but-unapproved certificate | Edge denial and zero origin counters for each case. Include a valid approved certificate as control. |
| Spoofed identity/capability headers; alternate path, port, hostname and direct-origin address | No bypass around selected admission policy. Probe every configured public authority, not only the invite URL. |
| Revoke selected device/policy grant | New connections denied with zero origin events after verified policy propagation; separately verify existing sessions are closed as required. |
| Disable/restart/crash/reconfigure | No unexpected route revival or forwarding to a different service that later claims the old loopback port. |

An HTTP 403 or failed TLS handshake alone cannot prove no forwarding: the
response may come from origin or a local proxy. For a public-edge claim, require
provider-side correlated denial evidence as well as zero origin events; if that
evidence is unavailable, report the boundary as unverified. Finite probes establish
the tested configuration, not perpetual protection after policy drift.

## Setup and cleanup lifecycle proposal

Before mutation, snapshot the exact authority, handlers, exposure flag, expected
target and selected CLI identity/version. Reserve an unoccupied authority rather
than silently switching a shared port. Save a small PwrAgent-owned setup journal
at lifecycle boundaries. Serialize setup per machine/authority across profiles;
reject conflicting owners. Do not store secrets or raw peer status in that journal.

After mutation, reread exact configuration and verify target, HTTPS mode, hostname,
port and private exposure; then test reachability/admission and save the invite
endpoint. Report configured, reachable and admission-verified as distinct states.
On failure, remove only the route still matching the transaction's expected
configuration. If another actor changed it, stop rollback and report the precise
conflict. Never restore an entire stale status snapshot over another app's edits.

Background routes survive daemon/device restarts until disabled, so stopping
PwrAgent is not cleanup. Use explicit disconnect/remove operations and reconcile
on next start; handle an interrupted transaction. Use scoped `off` and recheck
remaining handlers/exposure. Never use broad `reset` for normal cleanup.
[CLI persistence and removal](https://tailscale.com/docs/reference/tailscale-cli/funnel).

For private Serve, an abandoned route can still expose a later port occupant to
allowed tailnet clients. For existing Funnel, the same issue reaches the internet.
Include this crash/port-reuse risk in the implementation acceptance gate; an
ownership journal alone cannot eliminate it. Do not claim fail-closed crash
behavior until the forwarding lifetime has an enforced owner.

Do not run global logout/down or remove shared HTTPS/MagicDNS settings during
cleanup. Do not revoke a shared publishing capability just because one route is
removed. If a future managed integration creates devices, delete only its owned
devices and verify deauthorization. Revoking an enrollment auth key does not
deauthorize devices already registered with it; tagged devices also have key
expiry disabled by default. [Auth-key lifecycle](https://tailscale.com/docs/features/access-control/auth-keys).

## Pricing and operating feasibility

Current pricing lists Personal at $0 for up to six users, unlimited user devices,
three ACL groups and 50 tagged resources initially. Personal is for noncommercial
use. Standard lists $8/user/month and Premium $18/user/month; verify applicable
seat/resource charges before promising a business deployment cost. There is no
basis here to advertise universally free commercial federation.
[Pricing and eligibility](https://tailscale.com/pricing).

Funnel is available across plans, but its bandwidth limit has no numeric guarantee
on the reviewed feature page. Do not invent throughput or an SLA. A personal
experiment can be free within eligibility and limits; heavy attachment transfers
and interactive terminal traffic need measured latency/throughput before any
reliability promise. [Funnel availability](https://tailscale.com/docs/features/tailscale-funnel).

Private Serve avoids public client credential issuance and a purchased custom
domain. The tradeoff is installing/enrolling each client in Tailscale and managing
tailnet authorization. That is likely the lowest operational burden for users
who already use Tailscale, while a mandatory public-edge mTLS design serves a
different client deployment requirement.

## Bounded implementation recommendation

Three separately reviewable changes, if approved:

1. **Correct status and exposure reporting.** Validate exact handler target and
   authority, distinguish private/public state, detect shared-port conflicts,
   and correct the stale cleanup guidance. Update focused mocked CLI tests for
   wrong target/type/port, private-to-public sibling exposure and state drift.
   Keep existing Funnel explicitly classified as public origin reachability;
   exclude it from any “edge protected” setup choice.
2. **Guide existing-install Serve setup and removal.** Add resumable prerequisites,
   owned-route lifecycle, conditional rollback and exact cleanup. Cover URL-save
   failure, timeout-after-mutation, concurrent profiles, interrupted cleanup and
   restart behavior. No OAuth, automatic tailnet creation, new proxy, client PKI
   or Cloudflare changes in this slice.
3. **Add admission verification.** Implement the isolated positive/negative probe
   harness above, with boundary counters and evidence export. Require an
   authorized live run before labelling a setup verified. Policy inspection can
   be operator-assisted initially; unavailable proof must remain visible.

No per-event database writes are needed for probe counters. If lifecycle
persistence adds SQLite commits, measure the actual mutation budget and include
the repository-required checked-in budget and MB/day projection. Do not add
periodic persistence merely to refresh status.

Defer raw-TCP/local-mTLS and embedded/API-only Tailscale designs to separate
decisions. Neither is necessary to improve Serve, and neither solves Funnel's
missing public-edge client admission. Revisit Funnel only with new official
support for that boundary and passing negative evidence.

## Research provenance and validation

Used the Context7 skill: resolved official library `/websites/tailscale`, then
queried security boundaries, setup/CLI lifecycle and pricing separately. Followed
with current official Tailscale pages to inspect detailed controls and newly
documented OAuth/Tailnets APIs. Links are placed beside the claims they support.
Feature documentation is dated/validated independently; fetch date does not
imply an on-device compatibility test.

Validation for this record: current-source inspection, comparison against
official docs, relative-link checks and `git diff --check`. No product tests or
live endpoint tests were run because the only change is this research record.
