---
status: pending
priority: p2
issue_id: "003"
tags: [code-review, architecture, multi-window, frontend]
dependencies: []
---

# Replace ad-hoc hash check in main.tsx with a tiny route registry

`main.tsx` chooses between `<App />` and `<MessagingActivityWindow />` via a single `if (hash === "messaging-activity")`. That works for one secondary window but becomes a switch statement at the second, and silently mounts the full app shell on any unrecognized hash — which will be a footgun once a path-style hash like `#thread/abc123` is introduced.

## Problem Statement

`apps/desktop/src/renderer/src/main.tsx:22-28` does an exact-string compare on the hash:

```ts
function chooseRoot(): ReactElement {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "messaging-activity") return <MessagingActivityWindow />;
  return <App />;
}
```

Adding a third route means another `if`. Adding a path-style hash (`#thread/foo`) means parsing inside this function with no clear pattern. The fallback policy is "any unrecognized hash mounts the full app" with no explicit declaration.

## Findings

- `main.tsx:22-28` is the only multi-window routing decision point in the codebase.
- No existing router module — this is the first multi-window pattern.
- The cost to land a tiny registry now is ~10 lines; the cost to retrofit when route #3 arrives will be the same plus a churn moment in a hot file.

## Proposed Solutions

### Option 1: Tiny prefix-match registry

**Approach:**

```ts
const routes: Array<{
  match: (hash: string) => boolean;
  render: () => ReactElement;
}> = [
  { match: (h) => h === "messaging-activity", render: () => <MessagingActivityWindow /> },
];

function chooseRoot(): ReactElement {
  const hash = window.location.hash.replace(/^#/, "");
  return routes.find((r) => r.match(hash))?.render() ?? <App />;
}
```

Future routes get one entry in the array; fallback is explicit.

**Pros:**
- Adds minimal LOC.
- Path-style hashes naturally fit the `match` function.
- Explicit fallback.

**Cons:**
- Introduces a registry pattern with one entry — slight YAGNI risk if a third route never lands.

**Effort:** 15 min
**Risk:** Low

### Option 2: Defer until the third route lands

**Approach:** Leave as-is. Refactor when needed.

**Pros:**
- No work now.

**Cons:**
- Refactor moment is in a hot file; reviewer may push back.

**Effort:** 0
**Risk:** Low

## Recommended Action

(To be filled during triage.) Option 1 if we expect Settings-as-window or Diagnostics-as-window soon; Option 2 otherwise.

## Technical Details

**Affected files:**
- `apps/desktop/src/renderer/src/main.tsx:22-28`

## Resources

- **PR:** #198
- **Reviewer:** architecture-strategist — C2

## Acceptance Criteria

- [ ] Route resolution lives in a data structure, not an `if` chain
- [ ] Fallback policy is explicit
- [ ] Path-style hashes (e.g. `thread/abc`) can be added without restructuring
- [ ] Existing behavior preserved (activity hash → activity window; everything else → App)

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via architecture-strategist agent
