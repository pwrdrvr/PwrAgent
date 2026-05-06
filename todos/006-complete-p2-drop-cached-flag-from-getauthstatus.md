---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, simplicity, architecture, gh-fetcher]
dependencies: []
---

# Move `logDebug` inside the gh fetcher; drop the `cached` return flag

`getAuthStatus()` returns `Promise<GhAuthStatus & { cached: boolean }>`. The lone caller in `app-server.ts` destructures `cached` only to gate `logDebug`. The intermediate type, the three `{ ...value, cached: true|false }` spreads, and the destructure-and-omit pattern at the IPC handler exist purely to ferry one log decision across a layer boundary.

## Problem Statement

Three reviewers (code-simplicity #4, kieran-typescript #2, architecture-strategist I3) independently flagged the same shape:

- `apps/desktop/src/main/pr-status/github-pr-fetcher.ts:232-276` — `getAuthStatus` builds `{ ...value, cached: false }` on the fresh path and `{ ...this.authStatusCache.value, cached: true }` on the cached path. In-flight sharers also tag `cached: true`.
- `apps/desktop/src/main/ipc/app-server.ts:472-486` — destructures `{ cached, ...status }`, conditionally logs, returns `status` (the `Omit<>` widens back to `GhAuthStatus`).

The `cached` flag is an internal implementation detail that leaks through the type. Every caller has to remember to strip it before returning to the renderer.

## Findings

- The IPC contract (`Promise<GhStatus>`) is already preserved; the leak is type-shape, not wire-shape.
- `getAuthStatus` is called from exactly one place currently (the IPC handler).
- The fetcher has access to a logger (`fetcherLog` at line 7); moving the log call inside is mechanical.

## Proposed Solutions

### Option 1: Move logging inside the fetcher

**Approach:**
- Add a `logger?: (status: GhAuthStatus) => void` parameter to `getAuthStatus` (or accept a `getMainLogger` reference at construction time and use it directly).
- Log inside the "fresh probe" branch only.
- Return plain `GhAuthStatus`.
- IPC handler becomes one line: `return await fetcher.getAuthStatus();`.

**Pros:**
- Removes `cached: boolean` from the public return type.
- Removes 5 lines from the IPC handler.
- The fetcher owns both the cache AND the logging cadence — single source of truth.

**Cons:**
- The fetcher constructor now needs a logger reference (`appServerLog` from `app-server.ts:23`). Tests need to pass a mock or default to a no-op.

**Effort:** 30 min
**Risk:** Low (tests already in place)

### Option 2: Tuple return shape

**Approach:** Change to `Promise<{ status: GhAuthStatus; cached: boolean }>` so the fact that `cached` is metadata (not part of the wire shape) is encoded in the type.

**Pros:**
- Minimal change; preserves caller flexibility.

**Cons:**
- Doesn't actually solve the leak — `cached` is still in the public return, just moved from `&`-merged to a sibling field.

**Effort:** 15 min
**Risk:** Low

## Recommended Action

(To be filled during triage.) Option 1 — kills the awkward shape entirely.

## Technical Details

**Affected files:**
- `apps/desktop/src/main/pr-status/github-pr-fetcher.ts:232-276` — strip `cached`, log on fresh probe
- `apps/desktop/src/main/ipc/app-server.ts:467-486` — collapse to one line
- `apps/desktop/src/main/__tests__/github-pr-fetcher.test.ts:441-528` — tests assert on `cached` flag; rewrite to count subprocess invocations instead

## Resources

- **PR:** #198
- **Reviewers:** code-simplicity-reviewer #4, kieran-typescript #2, architecture-strategist I3 — three independent flags

## Acceptance Criteria

- [ ] `getAuthStatus` returns plain `Promise<GhAuthStatus>`
- [ ] `logDebug("getGhStatus", ...)` fires once per fresh probe; never on cached returns or in-flight sharers
- [ ] Existing tests still pass (rewrite the dedup tests to assert on `runGhAuthStatus` call count, not `cached` flag)
- [ ] No regression in main-IPC contract

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via three reviewers (code-simplicity, kieran-typescript, architecture-strategist)
