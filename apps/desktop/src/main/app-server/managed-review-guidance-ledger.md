Approach (two-pass workflow):

Pass 1 — Static inspection and immediate candidate capture:
- Perform a static, adversarial code review. Read the complete diff, commit messages or PR intent when available, the changed files, their direct callers/tests, and governing repository rules or standards (such as AGENTS.md, CLAUDE.md, or CODING_STANDARDS.md for the changed paths) at the reviewed revision.
- Stay purely static and bounded: use read-only git/file inspection only (aim for ~10–18 read-only calls across the diff, changed files, direct callers/tests, and governing rules; batch related reads). Do not run lint, typecheck, build, or test suites, do not launch ad-hoc reproduction or runtime probe scripts, do not search the web to chase speculative framework internals, and do not audit unrelated modules. Only run a targeted read-only command if a concrete ambiguity in repository source cannot be resolved by reading files.
- Mentally execute the changed paths across boundary inputs, error/cancellation/cleanup paths, concurrency/ordering interleavings, and process or lifecycle boundaries.
- Whenever you notice a concrete defect, regression, contract or telemetry mismatch, hot-path performance regression, live/replay parity bug, non-falsifying regression test, or explicit repository-rule violation, call `record_review_candidate` IMMEDIATELY before moving to the next file — do not wait until the end of the review.
- Once the diff, changed files, direct callers/tests, and governing rules have been inspected, stop exploring and move to Pass 2.

What to check during Pass 1:
- Correctness and contracts (both regressions and newly introduced behavior): trace logic errors, invalid state transitions, race conditions, broken error propagation, resource/lifecycle leaks, dangling references to deleted or renamed files/symbols, hot-path regressions (such as synchronous DB/disk I/O added to streamed event paths), live vs. replay parity mismatches, and mismatches between stated intent and implementation. Check new APIs, fields, logs, and telemetry/metrics to verify their actual values, scope, and timing match their names and documented semantics.
- Test fidelity and falsifiability: state the core bug or behavioral invariant the diff claims to fix or establish, then inspect the actual assertions in the added or updated tests (unit, property, integration, and E2E). Ask: if the core fix were reverted to the broken behavior (even while keeping the new field or type shapes), would at least one non-mocked assertion fail? Merely invoking the new code path or asserting output shapes, types, truthiness, or no-throw is not falsification: if a regression test lacks an assertion on the actual invariant being restored (or mocks away the boundary the fix changes, or checks a proxy instead of the invariant), record it, along with any missing coverage for core changed behavior or error paths.
- Repository standards: flag concrete violations of explicit rules in governing repository instructions or standards files, citing the violated rule.

Pass 2 — Bucket, prioritize, and disposition every candidate:
- Call `list_review_candidates` to review every candidate recorded in Pass 1.
- Group related candidates by category and root cause so overlapping observations collapse cleanly without duplicate findings.
- Call `dispose_review_candidate` on EVERY candidate before calling `submit_review_output`:
  - Mark `keep` with a calibrated `priority` (`0`–`3`) for every concrete defect backed by code evidence. Do NOT drop a concrete P2 or P3 defect simply because it feels minor, is a narrow edge case, or works in the common case.
  - Refine a kept candidate by ID in the same call when its `summary` (title), `mechanism` (body), `file`, `start_line`, `end_line`, or `category` needs a correction. You can supply `confidence_score` when you can assess your certainty. Leave accurate details as recorded.
  - Mark `drop` only with a concrete, code-grounded justification (for example: a verified caller or guard already prevents the bug, the path is unreachable, the candidate is a pure style or formatting nitpick, it is a duplicate merged into another kept candidate, or it is unrelated pre-existing code untouched by the diff).

Evidence and signal discipline:
- Ground every finding in the reviewed code; check callers, guards, and surrounding context before claiming something is missing or wrong.
- Lead each finding's body with the concrete observable consequence or failure scenario, explain the mechanism in the code, and propose a specific fix when clear.
- Suppress noise: do not report style or formatting nitpicks, speculative hypotheticals without a reachable failure path, issues already handled elsewhere, or unrelated pre-existing issues in untouched code that the diff does not newly expose.
- If the ledger is full, retain the evidence for any candidate whose recording was rejected. Apply the same verification and deduplication before including it as an explicit finding at submission.
