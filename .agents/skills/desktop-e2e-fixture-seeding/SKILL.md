---
name: desktop-e2e-fixture-seeding
description: Record, export, derive, and refresh desktop replay-backed E2E fixtures for PwrAgnt. Use when Codex needs to seed or update `apps/desktop/e2e/fixtures/*` from a live desktop session with Computer Use, add a new capture recipe, promote `raw.capture.jsonl` into `replay.fixture.json`, or wire a replay-backed Electron spec around a captured scenario.
---

# Desktop E2E Fixture Seeding

Use this skill to turn a live desktop session into replay-backed Electron test
coverage.

## Read First

Repo and desktop `AGENTS.md` instructions already apply. For this workflow,
read these files first:

1. [../../../apps/desktop/e2e/fixtures/README.md](../../../apps/desktop/e2e/fixtures/README.md)

Then read the scenario recipe you are seeding or refreshing:

- [../../../apps/desktop/e2e/fixtures/approval-pending/capture-recipe.md](../../../apps/desktop/e2e/fixtures/approval-pending/capture-recipe.md)
- [../../../apps/desktop/e2e/fixtures/turn-lifecycle/capture-recipe.md](../../../apps/desktop/e2e/fixtures/turn-lifecycle/capture-recipe.md)
- [../../../apps/desktop/e2e/fixtures/edited-changes-order/capture-recipe.md](../../../apps/desktop/e2e/fixtures/edited-changes-order/capture-recipe.md)

If you are adding a new scenario, mirror those recipe files and update the
shared fixture workflow doc.

## Workflow

1. Pick the scenario and confirm whether you are refreshing an existing fixture
   or adding a new one.
2. Prepare a disposable worktree if the capture recipe edits files.
3. Launch the desktop app in record mode:

   ```bash
   PWRAGNT_PROTOCOL_CAPTURE=true \
   PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragnt-protocol-captures \
   pnpm dev
   ```

4. Use Computer Use primitives only and follow the scenario recipe exactly:
   - `get_app_state`
   - `click`
   - `type_text`
   - `press_key`
   - `scroll`
5. Stop at the recipe's documented stop point. Record the backend-qualified
   session id, thread id, and capture id if the export flow exposes them.
6. Export the raw session evidence:

   ```bash
   pnpm --filter @pwragnt/desktop export:session-capture -- \
     --capture-root /tmp/pwragnt-protocol-captures \
     --session codex:<thread-id> \
     --output /tmp/<scenario>.raw.capture.jsonl
   ```

7. Derive the curated replay fixture:

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

8. Add or update the Playwright Electron spec. Follow the style in:
   - [../../../apps/desktop/e2e/smoke.spec.ts](../../../apps/desktop/e2e/smoke.spec.ts)
   - [../../../apps/desktop/e2e/edited-changes-order.spec.ts](../../../apps/desktop/e2e/edited-changes-order.spec.ts)
9. Run the relevant checks:

   ```bash
   pnpm test:desktop-e2e
   pnpm test
   pnpm typecheck
   ```

## Guardrails

- Do not hand-edit `raw.capture.jsonl`.
- Keep the replay window tight. Preserve only the protocol slice needed for the
  user-visible assertion.
- Keep `capture-recipe.md`, `raw.capture.jsonl`, and `replay.fixture.json`
  together in the same scenario directory.
- Prefer assertions on visible UI outcomes, transcript order, and composer
  state rather than protocol internals.
- Update [../../../README.md](../../../README.md) and
  [../../../apps/desktop/e2e/fixtures/README.md](../../../apps/desktop/e2e/fixtures/README.md)
  when you add a new scenario or materially change the operator workflow.
