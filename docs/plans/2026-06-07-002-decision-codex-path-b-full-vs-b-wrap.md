---
title: "Decision 2: Codex path for Phase B — B-full vs B-wrap (vs staged hybrid)"
status: decision-draft
supersedes-note: "Resolves the deferred Decision 2 in 2026-06-06-001 §Decisions."
---

# Decision 2 — the Codex path for Phase B

The Wave-2 plan
([2026-06-06-001](2026-06-06-001-feat-acp-agent-kit-adoption-and-settings-redesign-plan.md)
§"Decisions" #2) deferred the Codex-path choice with an instruction to "write up
the two options in detail before Phase B starts." This is that write-up, now
grounded in a quantified read of both codebases.

## The two goals (and the tension)

1. **Delete a ton of code.**
2. **Do not break PwrAgent functionality.**

The research shows these two goals **pull in opposite directions for Codex**,
because the single biggest deletable artifact — the 5,918-line in-tree Codex
client — substantially implements features the kit **does not provide**. So a
naive "delete it and adopt the kit" both *under-deletes* (the rich features must
stay somewhere) and *risks breakage* (those features have no kit home yet). The
recommendation below threads that needle.

## TL;DR recommendation

**Staged B-full (a.k.a. "hybrid B-full").** Adopt the kit's `CodexThreadClient`
+ `ChatThreadController` + `normalize` for the **common path** (thread/turn
lifecycle, streaming, tool calls, approvals, normalization) and unify Codex +
ACP behind the kit's `AgentBackend` — gated by extending B1's parity harness to
Codex. Keep PwrAgent's **rich Codex orchestration** (steering, compaction,
review, environments) as thin extensions, and **upstream the missing primitives
to agent-kit** as we go — exactly the loop that just worked for agent-kit#1.

This gets the architectural win + a real (thousands-of-lines) deletion **without
betting the rich features on a kit that doesn't host them yet**, and without the
all-or-nothing risk of pure B-full or the dead-end duplication of pure B-wrap.

Do **not** do pure B-full first (it deletes code that has no kit replacement →
breakage). Do **not** settle for pure B-wrap (it *adds* code and permanently
forks the kit's controller/normalizer — fails goal 1).

## What we measured

### Renderer contract — identical for both backends (the key enabler)
Codex and ACP already hand the renderer the **same** `AppServerThreadReplay` +
`AgentEvent` shapes; the renderer doesn't know which backend produced a thread.
So an `AgentBackend` abstraction is *natural*, not forced — both options are
architecturally viable. (Source: `backend-registry.ts` dispatch + the shared IPC
contract.)

### Protocol version — exact match (green light)
PwrAgent, the kit's `agent-client`, and PwrSnap **all pin
`@pwrdrvr/codex-app-server-protocol` 0.133.0**. No version-skew risk for B-full.

### The in-tree Codex surface (what's on the table)
| Area | File(s) | LOC | Nature |
| --- | --- | ---: | --- |
| Codex client + normalization | `codex-app-server/client.ts` | 5,918 | **common (kit-replaceable) + rich features mixed** |
| stdio transport | `codex-app-server/stdio-transport.ts` | 96 | common (kit has agent-transport) |
| directory enricher | `codex-app-server/thread-directory-enricher.ts` | 304 | PwrAgent feature (survives both) |
| Codex environments | `codex-environment-{config,runtime,hydration-store}.ts` | 1,685 | **Codex-only, no ACP/kit equivalent — survives both** |
| backend dispatch | `backend-registry.ts` (subset) | ~100–150 of 10,474 | inline `isAcpBackendId`/`backend==="codex"` branches (~48 sites) |
| Codex client tests | `codex-client*.test.ts` + protocol analysis | ~6,700 | rewritten, not free-deleted |

### The kit's `agent-client` (what we'd adopt)
| Piece | LOC | Provides |
| --- | ---: | --- |
| `CodexThreadClient` | 523 | start/turn/fork/resume/archive/interrupt, **normalized event stream**, tool-call + approval seams; implements `AgentBackend` |
| `ChatThreadController` | 965 | surface-agnostic orchestrator driving **any** `AgentBackend` (Codex *and* ACP); `ThreadStore` persistence seam; `ChatControllerEvent`s |
| `normalize.ts` | 416 | Codex v2 → `NormalizedThreadEvent` (same neutral schema as ACP) |
| `AgentBackend` (agent-core) | 138 | **non-generic** interface; controller never branches per backend |

## The coverage gap — the crux of the decision

The kit covers the **common path** thoroughly, but **not** PwrAgent's rich Codex
features:

| PwrAgent Codex feature | Kit provides? | If B-full, who owns it |
| --- | --- | --- |
| start/turn/fork/resume/archive/interrupt | ✅ full | kit |
| streaming deltas, reasoning, tool calls, approvals | ✅ full | kit |
| normalization → neutral schema (unifies w/ ACP) | ✅ full | kit |
| model / serviceTier / reasoning / instructions / config | ✅ full | kit |
| environments (opaque pass-through at thread start) | ✅ full | kit passes; **runtime/setup stays PwrAgent** |
| CODEX_HOME / auth profiles (via `options.env`) | ✅ full (indirect) | PwrAgent discovery + kit env |
| token usage / context window | ✅ full | kit |
| **steering (`turn/steer`)** | ❌ none | **PwrAgent (or upstream)** |
| **compaction (`thread/compact/start`)** | ❌ none | **PwrAgent (or upstream)** |
| **review (`review/start`)** | ❌ none | **PwrAgent (or upstream)** |
| **fastMode** | ❌ not exposed | **PwrAgent (or upstream)** |
| `model/list`, `skills/list`, `experimentalFeature/list`, `mcpServerStatus/list`, `account/*`, `account/rateLimits` | ❌ none | **PwrAgent (direct Codex calls)** |
| `thread/read` full replay | ❌ not exposed (uses `ThreadStore` journal) | PwrAgent (journal or direct) |
| Codex environment **runtime/setup scripts** | ❌ none (only opaque pass-through) | **PwrAgent (survives both)** |

### PwrSnap is NOT proof the rich path works
PwrSnap wires `ChatThreadController` + `CodexThreadClient` end-to-end **for a
simple chat surface**: single-turn, `environments: []` (shell disabled), **no
steering, no compaction, no review, no environment setup**. It proves the
*common* path is solid — it does **not** prove PwrAgent's rich orchestration
survives a kit swap. Treat PwrSnap as validation of B2a (below), not B2b.

## Head-to-head

### Option A — pure B-full (swap client for `CodexThreadClient` now)
- **Deletes:** the most (client common + normalization + dispatch branching;
  ~thousands of LOC; tests rewritten).
- **Blast radius:** **HIGH and immediate** — steering/compaction/review/fastMode
  and the `*/list` + `account/*` queries have **no kit home**, so you either
  break them or bolt on direct-Codex calls that defeat the abstraction. Mid-turn
  execution-mode queueing (138 LOC in the registry) also has no kit seam.
- **Defers:** nothing — forces everything at once.
- **Verdict:** best on goal 1, **worst on goal 2**. Rejected as a first move.

### Option B — pure B-wrap (`AgentBackend` adapter around the in-tree client)
- **Deletes:** ~100–150 LOC of dispatch branching only.
- **Adds:** ~400–800 LOC (adapter) and — to get one controller across Codex+ACP
  — either depends on the kit's `ChatThreadController` anyway or **forks a
  965-LOC controller + 416-LOC normalizer in-tree that then drift** from the kit.
- **Blast radius:** LOW (keeps proven code).
- **Defers:** the actual deletion, indefinitely.
- **Verdict:** safe, but **fails goal 1** and risks permanent kit drift. Rejected
  as the end state.

### Option C — staged B-full / hybrid (recommended)
- **B2a (do first):** adopt `CodexThreadClient` + `ChatThreadController` +
  `normalize` for the common path; put Codex **and** ACP behind the kit's
  `AgentBackend`; route persistence through a `ThreadStore` impl over PwrAgent's
  SQLite. **Gate it by extending B1's parity harness to Codex** (replay Codex
  transcripts through old vs new, assert parity — we already have the harness +
  the capture pipeline). Collapse the ~48 dispatch branches into one polymorphic
  path.
  - *Deletes:* the common client + normalization + dispatch branching (real,
    thousands of LOC) and unifies two backends into one orchestrator.
- **B2b (in parallel / after):** for the rich features the kit lacks
  (steer/compact/review/fastMode), **upstream them to agent-kit** (PRs that add
  `steerTurn`/`compact`/`review`/`fastMode` to `CodexThreadClient` +
  `AgentBackend`), exactly like agent-kit#1. Until each lands, keep a **thin
  PwrAgent extension** that calls Codex directly through the same transport — an
  explicit, small, documented seam, not a fork of the whole client.
- **Survives either way (don't touch):** Codex environment runtime/setup
  (1,685 LOC), auth-profile discovery/login, directory enricher.
- **Blast radius:** MEDIUM and **staged** — the common path is parity-gated; the
  rich features move one at a time behind a stable seam.
- **Verdict:** the only option that serves **both** goals.

## Why staged B-full, concretely

- It deletes the plumbing (goal 1) **without** deleting code that has no
  replacement (goal 2).
- The renderer contract is already backend-agnostic, so the `AgentBackend`
  collapse is low-friction and immediately removes ~48 branch sites.
- The protocol versions match exactly (0.133.0), so the swap is mechanical, not a
  migration.
- B1 already gives us the **proof mechanism** (parity harness + capture pipeline)
  to make B2a safe — extend it to Codex and the swap is gated, not hoped.
- The agent-kit#1 loop (find gap → file upstream → consume) **just worked** end
  to end; the missing Codex primitives are the same pattern, and the kit is ours
  to extend.

## Risks & mitigations
- **Rich-feature regressions during B2a.** *Mitigation:* B2a only swaps the
  common path; steer/compact/review keep their current code behind the new seam
  until each is upstreamed + parity-checked.
- **`ThreadStore` semantics vs PwrAgent's SQLite/overlay model.** *Mitigation:*
  implement `ThreadStore` as a thin shim over the existing store; do not change
  persistence in B2a.
- **Execution-mode queueing (Codex rejects mid-turn perm changes).** *Mitigation:*
  keep the registry's queueing gate as an `AgentBackend` wrapper concern; it's
  Codex-specific and small.
- **Kit-PR latency for steer/compact/review.** *Mitigation:* the thin direct-call
  extensions are the fallback that ships regardless; upstreaming is an
  optimization, not a blocker.

## Open questions for sign-off
1. Accept staged B-full (Option C) as the Phase-B Codex strategy?
2. OK to extend B1's parity harness to Codex as the B2a gate (vs a lighter
   check)?
3. Preference on the rich-feature seam: upstream-first (slower, cleaner) vs
   thin-extension-first (faster, small in-tree surface) — the recommendation is
   thin-extension-first, upstream opportunistically.
