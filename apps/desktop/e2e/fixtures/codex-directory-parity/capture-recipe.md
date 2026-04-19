# Codex Directory Parity Capture Recipe

## Goal

Capture the live Codex startup `thread/list` traffic that determines whether the
`search-product` directory shows the same threads as Codex Desktop.

This scenario exists to prove three concrete cases:

- hide stale root threads `019cb1de-230c-71f1-a833-8880f2ea1a4a` and
  `019c9cc2-6ea3-7d40-817d-9590d9118bbd`
- keep deleted-worktree thread `019d88a2-0e0b-77f0-bfce-130ae8e37d8f`
- group that deleted-worktree thread back under
  `/Users/huntharo/GIPHY/search-product`

## Backend and Mode

- Backend: Codex
- Mode: `Default Access`

## Current Seed

This fixture is seeded from a live Codex startup capture taken on April 19,
2026 after the thread discovery request was aligned with Codex Desktop:

- `limit: 50`
- `sortKey: "updated_at"`
- `sourceKinds: ["cli", "vscode"]`

The checked-in replay fixture stays curated and normalized for Electron replay,
but `raw.capture.jsonl` preserves the real Codex protocol evidence.

## Launch

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragnt-protocol-captures \
pnpm --filter @pwragnt/desktop preview
```

## Computer Use Steps

1. Wait for the desktop shell to show the `Threads` heading.
2. Open the `directories` browse lens.
3. Expand `search-product`.
4. Confirm the visible rows are:
   - `search-product ProjMgr`
   - `Plan Slidev theme extraction`
   - `Create Project Manager deck`
5. Confirm the stale rows do not appear:
   - `is this thing on?`
   - `Gather Reddit feedback screenshots`

## Stop Point

Stop once the `search-product` directory contents match Codex Desktop.

## Export Hints

- The raw capture should include the initial `initialize` exchange and the first
  Codex `thread/list` request/response pair from startup.
- The protocol evidence should show `019d88a2-0e0b-77f0-bfce-130ae8e37d8f`
  inside the active updated-at window and should not require any rollout-file
  reads.

## Promotion Commands

```bash
pnpm --filter @pwragnt/desktop export:session-capture -- \
  --capture-root /tmp/pwragnt-protocol-captures \
  --capture-id <capture-id> \
  --output /tmp/codex-directory-parity.raw.capture.jsonl
```

The replay fixture for this scenario is maintained as a curated contract
fixture. Keep `raw.capture.jsonl` live-derived and update
`replay.fixture.json` only as needed to reflect the normalized sidebar state.
