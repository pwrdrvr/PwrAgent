---
status: pending
priority: p3
issue_id: "014"
tags: [code-review, docs, learnings]
dependencies: []
---

# Seed `docs/solutions/` with three high-value learnings from PR #198

`docs/solutions/` doesn't exist yet in the repo. The thread-branch-drift plan called this out (line 790: "this is a strong candidate for the first solutions doc"). PR #198 is itself an excellent seed for at least three independent solutions.

## Problem Statement

Three patterns landed in PR #198 that future agents working on similar problems would benefit from finding via the `learnings-researcher` agent:

1. **Electron multi-window IPC fan-out + scoped subscriptions**
2. **Main-process subprocess caching with React StrictMode dedup**
3. **Theme-contract test pattern for design-token enforcement across primitives**

Without solution docs, the next agent rediscovers these from scratch and may not converge on the same approach.

## Proposed Solution

Create three solution docs once PR #198 settles:

- `docs/solutions/2026-05-06-electron-multi-window-ipc-fanout.md`
- `docs/solutions/2026-05-06-subprocess-cache-with-strictmode-dedup.md`
- `docs/solutions/2026-05-06-theme-contract-test-pattern.md`

Each should include: the problem encountered, the option chosen, why it was chosen, file paths to reference, and `learnings-researcher` keywords.

**Effort:** 1-2 hours
**Risk:** None

## Recommended Action

(To be filled during triage.) Land after PR #198 merges so the solution docs reference real merged code.

## Affected Files

- `docs/solutions/` (new directory)
- (Optional) `AGENTS.md` — link to the solutions directory

## Resources

- **PR:** #198
- **Reviewer:** learnings-researcher
- **Cited past plan:** `docs/plans/2026-05-04-002-fix-thread-branch-drift-detection-plan.md` line 790

## Acceptance Criteria

- [ ] `docs/solutions/` directory exists
- [ ] Three solution docs written with concrete file references
- [ ] Solution docs use `learnings-researcher`-friendly keywords

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via learnings-researcher
