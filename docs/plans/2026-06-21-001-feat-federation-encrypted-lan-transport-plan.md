---
title: "feat: encrypted, identity-bound federation transport for direct/LAN mode"
type: feat
date: 2026-06-21
status: proposed
builds-on: docs/plans/2026-06-10-001-feat-pwragent-instance-federation-plan.md
---

# feat: encrypted, identity-bound federation transport for direct/LAN mode

## Summary

The federation MVP (PR #735) ships a working authenticated control plane, but the
transport channel is only secured at the *handshake*, not per message, and the
listener is plain `ws://`. Confidentiality and integrity are delegated wholesale
to an external Cloudflare Tunnel. That is fine for the WAN/tunnel posture, but it
leaves the **direct same-machine / same-LAN / cross-machine-without-tunnel**
posture exposed: an on-path attacker can read every envelope in cleartext and
inject forged agent-control envelopes (`startTurn`, `runCodexEnvironmentAction`,
`submitServerRequest`, `handoffThreadWorkspace`) into an already-authenticated
socket.

This plan adds an **ssh-like encrypted, mutually-authenticated, identity-bound
channel** that works without Cloudflare, reusing the existing pinned per-instance
identity as the trust anchor. After this change, crossing machines on a LAN is
safe by default and no agent control surface is reachable in cleartext.

This is the "polished local-only transport that does not assume Cloudflare or a
stable DNS hostname" that the original plan explicitly
[deferred to follow-up work](2026-06-10-001-feat-pwragent-instance-federation-plan.md).

---

## Problem Frame

The current transport
([`federation-transport.ts`](../../apps/desktop/src/main/federation/federation-transport.ts)):

- Binds a plain `http.createServer()` + `ws` `WebSocketServer` — there is **no
  TLS in the listener** (`federation-transport.ts:113`). The advertised URL is
  hard-coded `ws://`.
- Authenticates the peer **once** at connection time: a server-fresh nonce
  challenge, signed by the peer's pinned Ed25519 key
  (`federation-transport.ts:151`, `federation-enrollment.ts`). This part is
  sound — genuine TOFU host identity.
- After `auth.accepted`, sends every application `envelope` as raw
  `JSON.stringify(...)` (`federation-transport.ts:402-405`) with **no
  per-message signature, MAC, encryption, or session-binding**. The envelope
  type (`packages/shared/src/contracts/federation.ts`) has no signature field.

Consequences for the non-tunneled path:

- **Confidentiality:** all thread contents, prompts, transcripts, skills, and
  environment actions travel in cleartext.
- **Integrity / injection:** an on-path attacker can inject or modify envelopes
  on the live socket; the gateway trusts any frame arriving on an
  already-authenticated connection (the `sessionId` is never echoed/checked on
  inbound frames).
- **Default is loopback** (`listen_host = 127.0.0.1`,
  `desktop-settings-service.ts`), which is safe — but flipping `listen_host` to
  `0.0.0.0` for LAN use is one undefended config line away, and nothing warns or
  blocks it.

The crypto fundamentals that already exist (Ed25519 identity, fresh-nonce replay
protection, TOFU pinning enforced on reconnect, HMAC-hashed invite tokens,
secret/key redaction) are good and should be **kept**. The gap is specifically
the **channel** after authentication.

---

## Goals / Non-Goals

### Goals

- G1. Confidentiality + integrity + replay resistance for **every** federation
  message on direct/LAN connections, not just the handshake.
- G2. Mutual authentication bound to the **channel**, so a man-in-the-middle
  cannot splice an authenticated identity onto a channel it controls.
- G3. Reuse the existing pinned per-instance identity as the trust anchor (no
  CA, no cert lifecycle) — the ssh "known_hosts" model the operator asked for.
- G4. Safe-by-default: refuse non-loopback binds unless the encrypted channel is
  active; never silently downgrade to plaintext.
- G5. Preserve the Cloudflare-tunnel posture as a supported option (TLS already
  provided at the edge), with explicit, not implicit, configuration.

### Non-Goals

- Multi-gateway mesh, quorum, or peer discovery beyond what MVP already has.
- Automated Cloudflare provisioning.
- Replacing the existing Ed25519 identity model — we extend it, not rip it out.
- mDNS/zeroconf LAN auto-discovery (tracked separately; see Deferred).

---

## Key Technical Decisions

- **KTD1. Use the Noise Protocol Framework for the channel, not bolt-on TLS.**
  Noise (`Noise_IK_25519_ChaChaPoly_BLAKE2s` or `_SHA256`) gives mutual static-key
  authentication, forward secrecy, per-message AEAD, and built-in nonce counters
  (replay resistance) in a tiny dependency, using raw public keys as the trust
  anchor — exactly the ssh model. `wss://` + self-signed pinned certs is the
  considered alternative (see Alternatives); it works but drags in X.509/cert
  lifecycle and a *second* identity object next to the Ed25519 key, for no
  security gain over Noise in a no-CA, pinned-key world.

- **KTD2. Add an X25519 static channel key alongside the Ed25519 identity; bind
  the two.** Ed25519 is a signing key, not a DH key. Rather than convert the
  Ed25519 key to X25519 (cross-primitive key reuse — discouraged), generate a
  separate per-instance X25519 static, store it in the secret store next to the
  Ed25519 private key, and **bind it to the canonical identity** by including the
  X25519 static public key inside the Ed25519-signed enrollment/reconnect proof.
  The Ed25519 key stays the canonical pinned identity; the X25519 key is the
  channel key, authenticated by it.

- **KTD3. Run identity auth *inside* the encrypted channel and channel-bind the
  proof.** Sequence: (1) Noise IK handshake establishes the encrypted tunnel
  using the pinned static X25519 keys; (2) the existing Ed25519 challenge/proof
  runs *inside* that tunnel; (3) the signed proof includes the Noise **handshake
  hash** so the identity assertion is cryptographically bound to this specific
  channel. This kills the post-auth injection/splice problem (G2).

- **KTD4. Make transport security an explicit mode with a fail-closed guard.**
  Add `[federation] transport_security`: `encrypted` (Noise required, the new
  default for direct binds) or `tunnel` (plaintext to loopback, relies on
  Cloudflare TLS — only valid with a loopback `listen_host`). Refuse to start a
  non-loopback listener in `tunnel` mode. No silent fallback (follows the
  no-silent-security-fallback guidance in
  `docs/solutions/2026-05-07-codex-permission-mode-state-machine.md`).

- **KTD5. Prevent downgrade.** The protocol version is bumped and the required
  `transport_security` posture is part of the enrollment record, so a peer
  enrolled as `encrypted` cannot be tricked into a plaintext reconnect. A
  `tunnel`-mode peer is only honored on a loopback bind.

---

## High-Level Design

```
WebSocket upgrade (ws:// to loopback, or wss:// via Cloudflare at the edge)
        │
        ▼
[Noise_IK handshake]  ── static X25519 keys, pinned TOFU like the Ed25519 key
        │   establishes encrypted, mutually-authenticated tunnel
        ▼
[Ed25519 identity auth]  ── existing challenge/proof, now sent INSIDE the tunnel,
        │                    proof includes Noise handshake hash (channel binding)
        ▼
[Encrypted envelope transport]  ── every envelope is a Noise transport message
                                   (AEAD, monotonic nonce); no cleartext frames
```

- The Noise layer is a thin wrapper (`encrypt(plaintext) -> ciphertext`,
  `decrypt(ciphertext) -> plaintext`) around the existing `socket.send` /
  `message` handlers in `federation-transport.ts`. The `FederationSocketMessage`
  JSON shapes are unchanged; they are just carried as Noise transport payloads
  after the handshake.
- In `tunnel` mode, the Noise layer is skipped and behavior is identical to
  today (loopback only), so Cloudflare-fronted deployments keep working.

---

## Implementation Units

### U1. X25519 channel identity, bound to the Ed25519 identity

**Goal:** Each instance has a persistent X25519 static keypair, stored in the
secret store, authenticated by the canonical Ed25519 identity and pinned at
enrollment.

**Files:**
- `apps/desktop/src/main/federation/federation-identity.ts` (generate/load X25519
  static; helper to sign/verify the X25519 pubkey under the Ed25519 key)
- `apps/desktop/src/main/federation/federation-enrollment.ts` (include the
  X25519 static pubkey in the proof message; pin it on the peer record)
- `apps/desktop/src/main/federation/federation-store.ts` (persist
  `pinnedChannelPublicKey` next to `pinnedPublicKeyPem`)
- `packages/shared/src/contracts/federation.ts` (proof/peer contract fields)
- Tests: `federation-identity.test.ts`, `federation-enrollment.test.ts`,
  `federation-store.test.ts`

**Test scenarios:** happy-path enroll pins both keys; reconnect verifies the
channel key matches the pinned one; an X25519 static not signed by the pinned
Ed25519 key is rejected; missing channel key on a pre-existing peer fails closed
with a redacted error.

### U2. Noise secure-channel module

**Goal:** A self-contained, dependency-vetted Noise IK implementation wrapping a
duplex byte stream.

**Files:**
- `apps/desktop/src/main/federation/federation-secure-channel.ts` (new)
- `apps/desktop/package.json` (add a vetted Noise dependency — evaluate
  `@noble/ciphers` + `@noble/curves` hand-rolled IK, or an audited
  `noise-protocol` lib; record the choice + license in `THIRD_PARTY_LICENSES`)
- Tests: `apps/desktop/src/main/__tests__/federation-secure-channel.test.ts`

**Approach:** Expose `createInitiatorChannel({ staticPriv, remoteStaticPub })`
and `createResponderChannel({ staticPriv })` returning
`{ writeHandshake(), readHandshake(), encrypt(buf), decrypt(buf), handshakeHash }`.
Keep it transport-agnostic (operate on buffers) so it is unit-testable without
sockets.

**Test scenarios:** initiator/responder complete a handshake and exchange
encrypted round-trips; a tampered ciphertext fails the AEAD tag; a replayed frame
is rejected by the nonce counter; mismatched static keys fail the handshake;
`handshakeHash` is identical on both ends and unique per session.

### U3. Integrate the channel into the transport

**Goal:** Run Noise → identity auth → encrypted envelopes on both gateway and
client sides, channel-binding the Ed25519 proof.

**Files:**
- `apps/desktop/src/main/federation/federation-transport.ts`
- `apps/desktop/src/main/federation/federation-enrollment.ts`
  (`buildFederationProofMessage` gains a `channelBinding` field = Noise
  handshake hash; verify it on the server)
- `packages/shared/src/contracts/federation.ts`
  (`FEDERATION_PROTOCOL_VERSION` bump)
- Tests: `federation-transport.test.ts` (extend the existing real-socket test to
  run end-to-end encrypted)

**Approach:** On `connection`/`open`, perform the Noise handshake first. After it
completes, send the existing `auth.challenge` / `auth` / `auth.accepted` messages
as Noise-encrypted payloads, with the proof binding the handshake hash. Then wrap
`sendSocketMessage`/`parseSocketMessage` so envelopes are encrypted/decrypted. In
`tunnel` mode, skip Noise entirely (current code path).

**Test scenarios:** end-to-end encrypted handshake + request/response over a real
in-process socket; a passive observer of the raw socket bytes cannot recover
plaintext envelope contents; an injected raw-JSON envelope on the socket is
rejected (not decryptable); a proof with a stale/mismatched channel binding is
rejected (`policy_denied`); `tunnel` mode still interoperates on loopback.

### U4. Config, fail-closed guard, and Settings surface

**Goal:** Operator picks transport security; non-loopback plaintext is refused.

**Files:**
- `apps/desktop/src/main/settings/desktop-config.ts`
- `apps/desktop/src/main/settings/desktop-settings-service.ts`
- `packages/shared/src/contracts/settings.ts` (`transport_security` enum,
  default `encrypted`)
- `apps/desktop/src/main/federation/federation-runtime.ts` (refuse to bind
  non-loopback `listen_host` when `transport_security !== "encrypted"`; log a
  redacted, actionable error)
- `apps/desktop/src/renderer/src/features/settings/FederationSettings.tsx`
  (mode control + inline warning when a non-loopback host is set without
  encryption)
- Tests: `desktop-config-federation.test.ts`,
  `desktop-settings-service.test.ts`, `federation-runtime.test.ts`,
  `FederationSettings.test.tsx`

**Config evolution:** new key is additive with a safe default; follow
`docs/config-file-evolution.md` read-fallback/comment rules. Existing configs
(no `transport_security`) default to `encrypted` for direct binds; a loopback-only
`tunnel` deployment must opt in explicitly.

### U5. Transport hardening (lands with the above)

- Set `maxPayload` on the `WebSocketServer` (currently unbounded → ws default
  100 MB) — `federation-transport.ts:114`.
- Validate envelope shape (not just `parsed.envelope` truthy) before routing —
  `federation-transport.ts:416`.
- Reconcile the relay hop cap inconsistency surfaced in review
  (`relayRemoteBackendEvent` cap `1` vs router `maxHopCount` `4`).

### U6. Threat-model docs

- Update `docs/federation-architecture.md`: document the encrypted direct mode,
  the `tunnel` mode, the channel-binding property, and the explicit statement
  that no agent control surface is reachable in cleartext in `encrypted` mode.

---

## Alternatives Considered

- **`wss://` with pinned self-signed certs (TOFU on the cert fingerprint).**
  Works and is "standard," but: (a) introduces a second identity object (the
  cert) alongside the Ed25519 key, needing its own generation/rotation/expiry
  handling; (b) X.509 parsing surface; (c) channel binding to the *Ed25519*
  identity still has to be added on top. Rejected as more moving parts for no
  security gain over Noise in a no-CA, pinned-key deployment.
- **Convert Ed25519 → X25519 and reuse one key.** Cryptographically possible but
  reuses a key across signing and DH primitives, which is discouraged; KTD2's
  separate-but-bound key avoids the foot-gun.
- **Per-message Ed25519 signatures over the existing plaintext channel.** Adds
  integrity but not confidentiality, and is slower than AEAD. Insufficient for G1.

---

## Acceptance Examples

- AE1. Two instances on different machines on the same LAN (no Cloudflare),
  `transport_security = encrypted`, `listen_host = 0.0.0.0`: enrollment +
  remote thread operation succeed, and a packet capture of the link shows no
  cleartext thread/prompt content.
- AE2. With an active encrypted session, an attacker who injects a well-formed
  raw-JSON `startTurn` envelope onto the TCP stream is ignored (fails AEAD), and
  the session is unaffected or closed — the remote agent does not run the
  injected turn.
- AE3. Operator sets `listen_host = 0.0.0.0` with `transport_security = tunnel`:
  the gateway refuses to start the listener and Settings shows an actionable
  error explaining encryption is required for non-loopback binds.
- AE4. A peer enrolled in `encrypted` mode cannot complete a plaintext reconnect
  (downgrade attempt is rejected).
- AE5. Existing Cloudflare-tunnel deployments (`tunnel` mode, loopback bind)
  continue to work unchanged.

---

## Risks and Dependencies

| Risk | Impact | Mitigation |
|---|---|---|
| Noise library choice is unvetted / unmaintained | Crypto bugs, supply-chain risk | Prefer audited primitives (`@noble/*`); keep the IK state machine small and unit-tested; record license in `THIRD_PARTY_LICENSES`; pin version |
| Cross-primitive key handling done wrong | Identity/channel keys become forgeable | KTD2 separate X25519 bound by Ed25519 signature; tests reject unsigned/ mismatched channel keys |
| Downgrade to plaintext | LAN exposure persists despite the feature | KTD5: posture in enrollment record + protocol-version bump + non-loopback guard; no silent fallback |
| Channel established but identity not bound to it | MITM splices a valid identity onto its own channel | KTD3 channel-binding the Ed25519 proof to the Noise handshake hash; AE2/AE4 tests |
| Performance overhead of AEAD per envelope | Sluggish remote streaming | ChaCha20-Poly1305 is fast; benchmark transcript streaming; envelopes are small JSON |
| Added handshake round-trips | Slower connect | IK is 1-RTT for the initiator; acceptable for long-lived sessions |

---

## Sources

- Original plan & deferral:
  `docs/plans/2026-06-10-001-feat-pwragent-instance-federation-plan.md`
- Current transport gaps:
  `apps/desktop/src/main/federation/federation-transport.ts`,
  `packages/shared/src/contracts/federation.ts`
- No-silent-security-fallback guidance:
  `docs/solutions/2026-05-07-codex-permission-mode-state-machine.md`
- Noise Protocol Framework spec: https://noiseprotocol.org/noise.html
