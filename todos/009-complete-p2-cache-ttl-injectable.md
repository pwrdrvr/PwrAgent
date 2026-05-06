---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, testability, gh-fetcher]
dependencies: []
---

# Make gh-fetcher cache TTLs injectable via constructor options

Both cache TTLs (`GH_AVAILABLE_CACHE_TTL_MS`, `GH_AUTH_STATUS_CACHE_TTL_MS`) are module-private constants. Tests that want to verify TTL expiration have to either use `vi.useFakeTimers()` (couples tests to timer mocks) or call `invalidateGhCaches()` (which conflates "force re-probe" with "TTL elapsed").

## Problem Statement

`apps/desktop/src/main/pr-status/github-pr-fetcher.ts:26, 41` define:

```ts
const GH_AVAILABLE_CACHE_TTL_MS = 60_000;
const GH_AUTH_STATUS_CACHE_TTL_MS = 5 * 60_000;
```

`GithubPrFetcherOptions` (line 76-90) exposes `timeoutMs`, `exec`, `probeGhAvailable`, `runGhAuthStatus` for testing — but not the TTLs. Tests currently can't verify cache eviction without timer mocks.

## Findings

- `apps/desktop/src/main/__tests__/github-pr-fetcher.test.ts` — no test verifies cache eviction after TTL elapses.
- `invalidateGhCaches()` is called in tests as a proxy for "TTL elapsed" — that conflates two different code paths.

## Proposed Solutions

### Option 1: Add TTL options to `GithubPrFetcherOptions`

**Approach:**

```ts
export type GithubPrFetcherOptions = {
  // ... existing ...
  ghAvailableCacheTtlMs?: number;
  authStatusCacheTtlMs?: number;
};
```

Default to the module constants. Tests pass `authStatusCacheTtlMs: 1` to make the cache effectively non-existent.

**Pros:**
- Trivially small change.
- Enables direct TTL tests.
- Production behavior unchanged.

**Cons:**
- One more constructor option to remember.

**Effort:** 15 min
**Risk:** Low

## Recommended Action

(To be filled during triage.) Option 1 — bundle with todo #006 if it lands first.

## Technical Details

**Affected files:**
- `apps/desktop/src/main/pr-status/github-pr-fetcher.ts:76-90` — extend options
- `apps/desktop/src/main/__tests__/github-pr-fetcher.test.ts` — add a TTL eviction test

## Resources

- **PR:** #198
- **Reviewer:** architecture-strategist — I2

## Acceptance Criteria

- [ ] `GithubPrFetcherOptions` exposes `authStatusCacheTtlMs` and `ghAvailableCacheTtlMs`
- [ ] Defaults match the existing module constants
- [ ] Test verifies cache eviction after TTL elapses without using `useFakeTimers`
- [ ] Production behavior unchanged

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via architecture-strategist agent
