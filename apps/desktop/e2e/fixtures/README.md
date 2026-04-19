# Desktop Replay Fixture Seeding

This directory holds the deterministic replay artifacts that power the desktop
Electron E2E suite.

Each scenario directory should contain:

- `capture-recipe.md`: the live Computer Use recipe for reproducing the capture
- `raw.capture.jsonl`: the exported desktop-boundary evidence from a real session
- `replay.fixture.json`: the curated replay script derived from that raw capture

Until a scenario is fully seeded, its directory may contain only
`capture-recipe.md`.

## Recommended Capture Workflow

Use Computer Use on macOS against the live desktop app. The goal is to record
real desktop traffic once, then promote that session into a small replay
fixture for CI.

1. Launch the desktop app in record mode:

   ```bash
   PWRAGNT_PROTOCOL_CAPTURE=true \
   PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragnt-protocol-captures \
   pnpm dev
   ```

2. Use Computer Use primitives only:
   - `get_app_state`
   - `click`
   - `type_text`
   - `press_key`
   - `scroll`

3. Follow the scenario-local `capture-recipe.md` in the target fixture
   directory.

4. Export the recorded capture once the scenario reaches its documented stop
   point:

   ```bash
   pnpm --filter @pwragnt/desktop export:session-capture -- \
     --capture-root /tmp/pwragnt-protocol-captures \
     --session codex:<thread-id> \
     --output /tmp/<scenario>.raw.capture.jsonl
   ```

   If you intentionally created exactly one new protocol capture during the run,
   you can export by capture id instead:

   ```bash
   pnpm --filter @pwragnt/desktop export:session-capture -- \
     --capture-root /tmp/pwragnt-protocol-captures \
     --capture-id <capture-id> \
     --output /tmp/<scenario>.raw.capture.jsonl
   ```

5. Derive the curated fixture into this directory:

   ```bash
   pnpm --filter @pwragnt/desktop derive:replay-fixture -- \
     --input /tmp/<scenario>.raw.capture.jsonl \
     --output-dir apps/desktop/e2e/fixtures/<scenario> \
     --scenario <scenario> \
     --backend codex \
     --thread-id <thread-id> \
     --source-capture-id <capture-id> \
     --start <sequence> \
     --end <sequence>
   ```

6. Add or update the corresponding Playwright Electron spec and run:

   ```bash
   pnpm test:desktop-e2e
   ```

## Operator Rules

- Prefer a fresh capture per scenario. Do not bundle multiple scenario threads
  into one promotion pass unless you need shared evidence.
- Use a disposable worktree for recipes that edit files.
- Keep the derived replay window tight. Retain only the records needed to
  reproduce the UI state under test.
- Do not hand-edit `raw.capture.jsonl`.
- If a capture includes secrets or machine-specific paths, use the replay
  derivation redaction flags when promoting the fixture.

## Protocol Parity Fixture Inventory

The current fixture set is still valid after rollout-file removal, but most
desktop replay scenarios do not exercise Codex sidebar directory identity.

- `codex-todo-list/raw.capture.jsonl` now serves as the primary parity evidence
  fixture. Its real `thread/list` response includes `cwd`, `path`, and often
  `gitInfo.branch`, which is enough to characterize the supported Codex thread
  identity contract.
- `codex-directory-parity/raw.capture.jsonl` adds the startup/sidebar parity
  case for Codex Desktop directory browsing. Its live `thread/list` capture is
  the evidence for the `limit: 50` updated-at window plus deleted-worktree
  thread retention, while the curated replay fixture keeps the Electron spec
  deterministic.
- `codex-todo-list/replay.fixture.json` remains valid for transcript and plan
  rendering, but it does **not** cover startup/sidebar grouping parity. Like the
  other replay fixtures, it replays already-normalized thread summaries with
  `linkedDirectories: []`.
- `codex-directory-parity/replay.fixture.json` is the first checked-in replay
  fixture that asserts directory grouping parity from normalized thread
  summaries, including a deleted worktree that still belongs under its home
  repository directory.
- The current replay-backed Electron specs continue to cover transcript,
  approval, turn lifecycle, diff, and markdown behavior. None of the checked-in
  replay fixtures currently assert home-repo/worktree grouping or branch-drift
  display in the sidebar.
- Follow-up fixture refresh is only needed when we add a replay or Electron spec
  that must prove startup/sidebar grouping parity for Codex threads. Until then,
  the runtime contract is protected by main-process normalization tests plus the
  raw-capture protocol analyzer.

## Scenario Index

- `approval-pending/`: pending approval card and waiting composer state
- `turn-lifecycle/`: turn start, visible Stop button, and clean completion
- `edited-changes-order/`: edited-file activity that must remain in transcript
  order when expanded
- `codex-todo-list/`: selected Codex thread renders a persisted transcript task
  plan
- `codex-directory-parity/`: Codex startup directory list matches Codex Desktop
  for stale-root exclusion and deleted-worktree inclusion
- `grok-todo-list/`: Grok-backed task plan rendering contract for the shared
  transcript plan UI
- `live-plan-updates/`: live `turn/plan/updated` rendering for in-flight task
  plan UI
- `long-thread-scroll-stability/`: very tall transcript opens at bottom without
  drift and restores a saved viewport on reselect
- `thread-scroll-restore/`: cached thread reselection preserves transcript
  viewport and avoids an extra replay `thread/read`
- `focused-diff-zoom/`: eligible transcript diffs that condense locally and can
  hide low-signal hunks via the focused diff path
