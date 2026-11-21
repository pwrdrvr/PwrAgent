# Review execution contract

`StartReviewRequest.runMode` selects the review engine independently of the
native Codex protocol's `delivery` field.

| Label | Wire value | Execution |
| --- | --- | --- |
| Codex Sub Agent | `codex-sub-agent` | Native `review/start`, with `delivery: inline`; default selection. |
| PwrAgent Sub Agent | `pwragent-sub-agent` | Existing ephemeral managed reviewer, with results retained on the parent. |
| Claude Code | `claude-code-review` | Claude Code's `/code-review`, sent as the Claude thread's own turn; its effort level is `reasoningEffort`. |

Codex's native reviewer already runs on the parent thread, so there is no
separate prompted inline mode. Transcript projection still hides the
`pwragent-inline-review-instructions` envelope, which development builds of a
prompted mode sent as an ordinary turn, while retaining unmarked user-authored
review instructions.

## Compatibility and validation

- An omitted `runMode` preserves native review by default. ACP parents,
  cross-provider reviewers, and secondary workspaces retain their existing
  managed-review requirement. A different model on the same provider alone does
  not require managed review.
- An explicit Codex mode that conflicts with one of these constraints is
  rejected. UI configurators select PwrAgent Sub Agent with an accessible reason
  when the operator changes the provider or workspace to a constrained choice.
- Unknown modes are rejected. Explicit modes accept omitted or `inline`
  delivery; combining any explicit mode with `detached` is rejected. Legacy
  requests without a mode retain their existing delivery semantics.
- `reviewRunMode` advertises owner support for this contract.
  `reviewCodexSubAgent` and `reviewRunner` independently advertise the two
  engines. Supporting ordinary turns does not imply native `review/start`
  support. Unavailable explicit modes fail without fallback.
- Federation checks the owner before sending an explicit mode, including
  scheduled-action creation or updates. An older owner's disabled selector
  reads Owner default; it sends no new mode field. Explicit transport requests
  to that owner fail with an update requirement.
- Queued and scheduled reviews retain the captured mode. Messaging's `/review`
  configurator and the `start_review` tool carry the same optional field.
  Launchpad exposes no mode selector because its materialization contract does
  not carry reviewer choices.
- A `pullRequests` target (several PRs together) requires the PwrAgent Sub
  Agent or Claude Code; `branch` and `path` targets require Claude Code. Each is
  refused on any other engine before anything is fetched.
- `claude-code-review` runs only on a Claude thread whose owner advertises
  `reviewClaudeCodeReview`, as its own reviewer, in its own workspace. It
  carries no reviewer override, and the start returns the turn that sent the
  command, which is where `ReportFindings` lands. Auto-fix is Claude Code's own
  `--fix` on that command, which settles the findings in the same turn, so the
  owner arms no second fix turn. An older owner rejects the unknown mode.
- The former Experimental managed-review switch is removed. Its configuration
  field remains readable and round-trippable for older installations, but no
  longer chooses the engine. No new timer or persistence operation is added;
  the mode is part of existing queue/schedule payloads.

## Native usage limitation

CLI 0.153.4's native inline reviewer was independently observed to emit no
`thread/tokenUsage/updated` notifications. Native parent/review thread identity
and inner/outer turn IDs are not evidence of token usage. Missing usage remains
unavailable; this selector does not repair pricing or attribute later cumulative
usage to the review. Existing synthetic usage tests that include a model do not
establish that the native runtime emits one.
