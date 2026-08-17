# Token Miser implementation plan

Status: Implemented; awaiting operator hook approval and live trial

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

## Open implementation questions

- Confirm whether `PostToolUse.tool_response` is uncapped for every supported
  MCP result. If not, combine the hook response with protocol-observed output
  only where Codex exposes the complete result without reading owned storage.
- Confirm the app-server hook inventory fields needed to prove exact-definition
  trust from PwrAgent.
- Decide whether the packaged hook launcher should be a small native helper or
  the Electron executable in Node mode on each supported operating system.
- Measure Luna medium latency and choose the fail-open timeout from live data.

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
