Approach (two-pass workflow):

Pass 1 — Systematic static inspection and immediate candidate capture:
- Perform a static, adversarial code review. Read the complete diff, commit messages or PR intent when available, every changed production file, their direct callers/tests, and governing repository rules or standards (such as AGENTS.md, CLAUDE.md, or CODING_STANDARDS.md for the changed paths) at the reviewed revision.
- Stay purely static and bounded: use read-only git/file inspection only (batch related file/hunk reads across changed files, direct callers/tests, and governing rules). Do not run lint, typecheck, build, or test suites, do not launch ad-hoc reproduction or runtime probe scripts, do not search the web to chase speculative framework internals, and do not audit unrelated modules. Only run a targeted read-only command if a concrete ambiguity in repository source cannot be resolved by reading files.
- Audit every changed production file systematically before ending Pass 1 — do not stop exploring after finding your first one or two issues. Mentally execute each changed path across boundary inputs, error/cancellation/cleanup paths, concurrency/ordering interleavings, and process or lifecycle boundaries.
- Whenever you notice a plausible concrete defect, regression, contract or telemetry mismatch, hot-path performance regression, live/replay parity bug, non-falsifying regression test, or explicit repository-rule violation, call `record_review_candidate` IMMEDIATELY before moving to the next file — do not wait until the end of the review, and defer deduplication and final keep/drop triage to Pass 2.
- Move to Pass 2 only after every changed production file, its direct callers/tests, and governing rules have been inspected.

What to check during Pass 1:
- Correctness and contracts (both regressions and newly introduced behavior): trace logic errors, invalid state transitions, race conditions, broken error propagation, resource/lifecycle leaks, dangling references to deleted or renamed files/symbols, hot-path regressions (such as synchronous DB/disk I/O added to streamed event paths), live vs. replay parity mismatches, and mismatches between stated intent and implementation. Check new APIs, fields, logs, and telemetry/metrics to verify their actual values, scope, and timing match their names and documented semantics.
- Test fidelity and falsifiability: state the core bug or behavioral invariant the diff claims to fix or establish, then inspect the actual assertions in the added or updated tests (unit, property, integration, and E2E). Ask: if the core fix were reverted to the broken behavior (even while keeping the new field or type shapes), would at least one non-mocked assertion fail? Merely invoking the new code path or asserting output shapes, types, truthiness, or no-throw is not falsification: if a regression test lacks an assertion on the actual invariant being restored (or mocks away the boundary the fix changes, or checks a proxy instead of the invariant), record it, along with any missing coverage for core changed behavior or error paths.
- Repository standards: flag concrete violations of explicit rules in governing repository instructions or standards files, citing the violated rule.

Pass 2 — Bucket, prioritize, and strictly triage every candidate:
- Call `list_review_candidates` to review every candidate recorded in Pass 1.
- Group related candidates by category and root cause so overlapping observations or secondary symptoms of the same bug collapse into one canonical finding.
- Call `dispose_review_candidate` on EVERY candidate before emitting your final JSON:
  - Mark `keep` with a calibrated `priority` (`0`–`3`) for every concrete, reachable defect backed by verified code evidence. Do NOT drop a concrete P2 or P3 defect with a verified reachable failure path simply because it feels minor, is a narrow edge case, or works in the common case.
  - Mark `drop` with a concrete, code-grounded justification whenever a candidate fails the bar:
    - a verified caller, guard, or invariant already prevents the bug, or the failure path is unreachable or purely speculative;
    - it is a feature request, UX preference, or alternative-design suggestion rather than a broken contract or regression introduced by the diff;
    - it is a style, formatting, naming, or minor test-style nitpick when existing tests already falsify the core invariant;
    - it is a duplicate or secondary symptom already covered by another kept candidate; or
    - it is unrelated pre-existing code untouched and not newly exposed by the diff.

Evidence and signal discipline:
- Ground every finding in the reviewed code; verify callers, guards, and surrounding context before keeping a candidate.
- Lead each finding's body with the concrete observable consequence or failure scenario, explain the mechanism in the code, and propose a specific fix when clear.
- Suppress noise: do not report style or formatting nitpicks, feature/UX suggestions, speculative hypotheticals without a reachable failure path, issues already handled elsewhere, or unrelated pre-existing issues in untouched code that the diff does not newly expose. Each kept finding must independently earn its place — do not pad a clean or well-tested change with low-value P3s.
- Emit one finding in your final JSON for every candidate marked `keep`, ordered by priority. Zero findings is valid when the change has no concrete defects (including when every Pass 1 candidate was legitimately dropped with code-grounded reasons).
