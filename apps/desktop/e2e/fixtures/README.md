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

## Scenario Index

- `approval-pending/`: pending approval card and waiting composer state
- `turn-lifecycle/`: turn start, visible Stop button, and clean completion
- `edited-changes-order/`: edited-file activity that must remain in transcript
  order when expanded
- `codex-todo-list/`: selected Codex thread renders a persisted transcript task
  plan
- `grok-todo-list/`: Grok-backed task plan rendering contract for the shared
  transcript plan UI
- `live-plan-updates/`: live `turn/plan/updated` rendering for in-flight task
  plan UI
- `focused-diff-zoom/`: eligible transcript diffs that condense locally and can
  hide low-signal hunks via the focused diff path
