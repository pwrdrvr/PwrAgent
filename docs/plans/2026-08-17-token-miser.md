# Token Miser implementation plan

Status: PwrAgent and Codex fork integration complete; live reducer-v2
acceptance, retrieval, replay-accounting, and off/on trials passed

## Decisions

- Ship Codex first using a synchronous `PostToolUse` hook.
- Keep the feature off by default under Usage & Pricing.
- Preserve Codex hook trust; require explicit approval for the exact PwrAgent
  hook definition.
- Use an ephemeral GPT-5.6-Luna helper at medium effort with all tools and
  inherited project instructions disabled.
- Store raw output in PwrAgent-owned files, never desktop SQLite or Codex-owned
  storage.
- Expose search, bounded read, and deliberate full-read dynamic tools.
- Fail open when interception, storage, or summarization is unavailable.
- Report estimated parent-context savings separately from net helper cost.
- Use Codex reducer protocol v2 for Code Mode output. Use `PostToolUse` only
  when Codex supplies the exact direct-call source and acceptance-v2 markers.
- Publish retrieval metadata, cards, and savings only after Codex acknowledges
  that it selected the replacement for model visibility.

## Milestones

1. Add a tested hook protocol adapter and profile-local authenticated bridge.
2. Add the preserved-output object store and retention enforcement.
3. Extend one-shot structured generation to accept medium reasoning effort and
   return helper token usage.
4. Add Token Miser classification, replacement formatting, and retrieval
   dynamic tools.
5. Add metadata accounting without per-chunk SQLite commits.
6. Add the Usage & Pricing switch, hook readiness state, and savings summary.
7. Add unit, protocol, security, failure, and SQLite write-budget coverage.

## Resolved implementation questions

- The integrated Codex fork supplies uncapped direct-hook input and reduces
  Code Mode output at the model-visibility seam. PwrAgent never reads
  Codex-owned storage.
- `server/capabilities/read` negotiates reducer protocol v2, thread-resume
  overrides, dynamic-tool replacement, nested-call source markers, and exact
  acceptance callback fields.
- The packaged hook launcher uses the Electron executable in Node mode and an
  instance-specific authenticated bridge descriptor on POSIX and Windows.
- The gate has bounded summarizer, reducer, and acceptance windows and fails
  open without publishing false savings when the replacement is not accepted.

## Progress

- 2026-08-17: Verified on Codex CLI 0.145.0 that `PostToolUse` receives a
  16,004-character random shell result and can replace it with a 155-character
  feedback message before the parent model reads the random data.
- 2026-08-17: Verified that the same hook is skipped without explicit hook
  trust or the unsafe bypass flag. The product will not use the bypass flag.
- 2026-08-17: Added the authenticated profile-local bridge, atomic output
  store, Luna-medium summary gate, thread-owned search/read/read-all tools,
  seven-day and 512 MB retention bounds, and fail-open behavior.
- 2026-08-17: Added the off-by-default Usage & Pricing switch and cumulative
  parent-context accounting. The estimate subtracts summary and retrieved
  tokens from the capped baseline and can report a negative saving.
- 2026-08-17: Added and validated the isolated `pwragent-token-miser` plugin
  source. Codex installation remains separate from exact-hook approval;
  operators must review the installed hook with `/hooks`.
- 2026-08-23: Added the Codex Code Mode output-reducer v2 bridge. PwrAgent now
  advertises a process-specific authenticated descriptor, stages the original
  output outside all retrieval and accounting views, and publishes a gate only
  after Codex explicitly acknowledges the exact replacement it accepted.
- 2026-08-23: Added exact reducer capability negotiation through
  `server/capabilities/read`. Unsupported Codex executables fail open, are
  reported unavailable, and do not receive fork-only config. Direct-tool
  interception requires the fork's explicit source and acceptance-v2 markers.
- 2026-08-23: Prevented nested Code Mode calls from also running the legacy
  gate, applied reducer config to new, forked, resumed, and review threads, and
  added stale staged-output pruning plus disconnect, timeout, and shutdown
  cleanup coverage.
- 2026-08-23: Validated the signed pwrdrvr/codex PR #8 artifact at exact head
  `517b781d`: all CI and signing-contract checks passed; `codex`,
  `codex-app-server`, and `codex-code-mode-host` are ARM64 executables reporting
  `0.146.0-pwragent.dev.4`; the live capability probe reported reducer v2 and
  dynamic-tool resume support.
- 2026-08-23: Completed the live trial on thread
  `01a03004-e501-73d0-ae72-2b130a3603b9`. One Code Mode gate compressed 35,314
  characters, produced no duplicate nested-shell gate, and kept the complete
  4,096-character random sentinel out of the parent rollout while retaining it
  in the PwrAgent-owned raw object. A bounded search retrieved only the marker;
  live Pricing, Sub-agents, and Explorer accounting updated immediately.
- 2026-08-23: Verified cached replay accounting through six observed payload
  replays and corrected Explorer's aggregate display to include both initial
  and cached avoidance. The same loaded thread removed retrieval tools when
  Token Miser was turned off and restored bounded retrieval when turned on
  again, without restarting Codex or PwrAgent.
