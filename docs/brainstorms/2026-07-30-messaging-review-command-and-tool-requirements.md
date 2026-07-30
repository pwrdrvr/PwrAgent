---
date: 2026-07-30
topic: messaging-review-command-and-tool
---

# Messaging Review Command and Tool

## Problem Frame

PwrAgent currently treats every slash-prefixed messaging event as a messaging
control command. Known controls such as `/resume` work, but an unrecognized
command such as `/review` falls through to the PwrAgent help menu instead of
reaching the bound coding thread.

Review is already a first-class desktop capability with structured targets and
review-result rendering. It should be one capability exposed consistently
through the desktop composer, messaging conversations, Codex dynamic tools, and
the PwrAgent MCP server.

## User Flow

```text
@PwrAgent /review
        |
        v
Review target picker
  | Base branch ------> choose project if needed -> choose branch
  | Current changes --> ready
  | Commit -----------> choose or enter SHA
  | Custom -----------> enter review instructions
        |
        v
Thread idle? ---- yes --> start review
        |
        no
        |
        v
Queue review after the active turn
        |
        v
Deliver progress and review result to the originating conversation
```

An Agent can reach the same operation by calling `start_review`. Because tools
are invoked during an active turn, the tool records the request and PwrAgent
starts it after the invoking turn completes successfully.

## Requirements

**Command routing**

- R1. Messaging control commands remain owned by the messaging controller:
  `/resume`, `/agent`, `/new`, `/status`, `/detach`, `/monitor`, and `/help`.
- R2. A slash-prefixed message that is not a messaging control command must be
  routed to the bound coding thread instead of producing the PwrAgent command
  menu. The routed text must preserve the command and its arguments.
- R3. R2 applies to addressed text on shared surfaces, including text remaining
  after an `@bot` mention is removed, and to direct messages where normal bound
  thread routing applies.
- R4. An unbound conversation cannot execute thread commands. It must receive a
  concise bind-first response with a Resume action rather than an unrelated
  generic command menu.
- R5. Provider-native slash commands remain subject to provider registration
  and namespace constraints. Textual `@bot /review` is the universal path and
  must not depend on native slash-command registration.
- R6. The help surface distinguishes messaging controls from thread commands.
  It shows `/review` when the bound backend supports review without classifying
  it as a messaging control command.

**Messaging review interaction**

- R7. Bare `/review` on a review-capable bound thread opens a channel-neutral
  review target picker rather than starting a default review immediately.
- R8. The picker exposes the same four targets as the desktop composer:
  Base branch, Current changes, Commit, and Custom.
- R9. If the thread has multiple linked Git workspaces, the interaction asks
  which workspace to review before collecting target-specific details.
- R10. Base branch offers known branch choices plus a text fallback. Commit
  offers known recent commits when available plus SHA entry. Custom accepts the
  operator's text verbatim as review instructions.
- R11. Providers render the interaction according to their capability profile:
  native choices/buttons where supported and numbered or free-form text
  fallbacks elsewhere.
- R12. Existing explicit desktop syntax also works from messaging without
  opening the picker:
  `/review <branch>`, `/review --commit <sha> [title]`, and
  `/review --custom <instructions>`.
- R13. If the thread is idle, a completed picker starts the review immediately.
  If a turn is active, PwrAgent queues the structured review request and starts
  it after earlier work reaches a successful terminal boundary.
- R14. The originating conversation receives an acknowledgement that names the
  selected target and says whether the review started or was queued.
- R15. Review progress and the final review artifact are delivered back to the
  originating conversation using the existing messaging review-artifact
  rendering and provider attachment fallbacks.
- R16. Unsupported backends receive a specific "Review is not supported by
  this Agent" response; `/review` must not silently become ordinary prompt text
  on those backends.

**Dynamic tool and MCP parity**

- R17. PwrAgent exposes a `start_review` Agent tool from the shared Agent-tool
  catalog. Adding it to that catalog makes the same contract available as a
  Codex dynamic tool and through PwrAgent's MCP server.
- R18. `start_review` targets the invoking PwrAgent thread. It accepts a
  structured review target equivalent to the existing review target contract:
  current changes, base branch, commit, or custom instructions. It may also
  identify one linked workspace when the thread has more than one.
- R19. The tool is intended for an explicit operator request to review work.
  Its description must not encourage an Agent to launch unsolicited reviews.
- R20. Since the tool is called during an active Agent turn, it records an
  idempotent pending review and starts that review only after the invoking turn
  completes successfully. A cancelled or failed invoking turn cancels the
  pending review.
- R21. The tool returns a stable pending-review identifier, normalized target
  summary, source thread identity, and status indicating that execution is
  scheduled. It tells the Agent to stop and let the turn finish rather than
  polling or issuing duplicate calls.
- R22. Repeating the same tool call ID must not schedule duplicate reviews.
- R23. Once started, the review uses the invoking thread's effective model,
  reasoning, service-tier, fast-mode, execution-mode, and workspace context
  unless an existing review policy requires a narrower setting.
- R24. Pending review state and its eventual review thread/result must be
  visible through existing thread inspection surfaces so the operator and
  Agent can determine what happened without relying on transient chat text.

**Free-form requests**

- R25. The initial messaging picker remains deterministic. Choosing Custom
  sends the supplied instructions directly as the review target; it does not
  create an additional interpretation subagent.
- R26. With `start_review` available, an operator may also ask the bound Agent
  for a review in ordinary language. The active Agent can interpret that
  request and call the structured tool, which schedules the review after the
  interpreting turn.
- R27. A future picker option may explicitly hand ambiguous free-form text and
  the available target choices to the bound Agent for interpretation. That is
  not required for the first implementation because R25 and R26 already cover
  exact custom instructions and natural-language orchestration.

## Success Criteria

- `@PwrAgent /review` in a bound Slack conversation displays the review picker
  instead of the PwrAgent command menu.
- Unknown non-control slash text in a bound conversation reaches the coding
  thread unchanged.
- An operator can configure and submit all four review target types from both
  interactive and text-only messaging providers.
- A review selected during active work starts once that work completes, without
  duplicate review starts.
- `start_review` appears with the same schema and behavior in both the Codex
  dynamic-tool catalog and the PwrAgent MCP tool list.
- Review results return to the conversation that initiated the review.

## Scope Boundaries

- Do not create a second interpretation subagent for the first version.
- Do not make `/review` a messaging-control verb.
- Do not register unnamespaced provider-native slash commands where doing so
  would collide with provider or workspace commands.
- Do not add provider-specific review workflow logic; provider differences are
  expressed through the generic messaging capability profile.
- Do not change the existing desktop review target meanings.
- Do not start a tool-requested review before the invoking turn has terminated.

## Key Decisions

- **Unknown slash fallthrough:** Messaging only owns its explicit control
  catalog. Other slash text belongs to the bound coding thread.
- **Bare review opens a picker:** This matches the desktop interaction and
  avoids silently choosing Current changes when the operator may mean a base
  branch, commit, or custom review.
- **One Agent-tool catalog entry:** Dynamic-tool and MCP exposure share the
  existing catalog rather than maintaining separate review contracts.
- **Terminal-boundary execution:** `start_review` schedules after the invoking
  turn completes because `review/start` cannot safely run concurrently with
  that turn.
- **No extra interpreter for v1:** Custom instructions can be passed directly,
  while ordinary natural-language requests can already be interpreted by the
  bound Agent using `start_review`.

## Dependencies / Assumptions

- The existing structured review target and `review/start` behavior remain the
  canonical execution contract.
- Existing messaging questionnaire primitives can express option selection and
  free-form answers, though planning must decide whether review warrants its own
  pending-intent kind.
- Existing review artifact rendering remains the output path and may need
  routing metadata so a review subthread's result returns to the initiating
  binding.

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R2-R5][Technical] Preserve the universal unknown-command fallthrough
  while correctly normalizing provider-native prefixes and mention-stripped
  text.
- [Affects R9-R12][Technical] Identify the channel-neutral navigation data
  needed for workspace, branch, and commit choices without importing
  provider-specific or renderer-only code.
- [Affects R13, R20-R24][Technical] Choose a durable pending-review record and
  terminal-event release mechanism shared by messaging and Agent-tool callers.
- [Affects R15][Technical] Confirm how review subthread events map back to the
  initiating source-thread binding and persist that association across restart.
- [Affects R17][Technical] Place `start_review` in the appropriate existing
  Agent-tool catalog without changing established tool compatibility contracts.

## Next Steps

→ `/ce:plan` for structured implementation planning.
