# Edited Changes Ordering Capture Recipe

## Goal

Capture a real Codex editing turn that produces an edited-file activity followed
by a normal assistant completion, so replay can assert that expanded diff
content stays in transcript order.

## Backend and Mode

- Backend: Codex
- Mode: `Default Access`

## Workspace Preparation

Use a disposable worktree. Before launching the desktop app, create a small
scratch file in the repo:

```bash
mkdir -p tmp
cat > tmp/edited-changes-ordering.ts <<'EOF'
export function sum() {
  const a = 1;
  const b = 2;
  return a + b;
}
EOF
```

This gives the agent a stable file to edit without touching product code.

## Launch

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragnt-protocol-captures \
pnpm dev
```

## Computer Use Steps

1. Wait for the `Threads` heading.
2. Click `New thread`.
3. Choose `Create thread with Codex in Default Access`.
4. Type this prompt:

   ```text
   Update tmp/edited-changes-ordering.ts by adding const c = 3 and returning
   a + b + c. Then tell me when you are done.
   ```

5. Send the turn.
6. Wait for the transcript to show an edited-file activity and then an
   assistant completion message.
7. Do not expand the edited changes while recording. The replay spec performs
   the expansion itself.
8. Record the thread id from the context rail.

## Stop Point

Stop after the assistant finishes and the transcript contains this full order:

1. user prompt
2. edited-file activity
3. assistant completion message

## Export Hints

- Preferred selector: `codex:<thread-id>`
- Initial replay window: first `initialize` through the `thread/read` response
  that contains the edited activity and the final assistant message
- Expected replay assertion surface:
  - `Edited 1 file` stays below the triggering user message
  - expanded diff content stays below the edited activity
  - final assistant message stays below the diff content

## Promotion Commands

```bash
pnpm --filter @pwragnt/desktop export:session-capture -- \
  --capture-root /tmp/pwragnt-protocol-captures \
  --session codex:<thread-id> \
  --output /tmp/edited-changes-order.raw.capture.jsonl
```

```bash
pnpm --filter @pwragnt/desktop derive:replay-fixture -- \
  --input /tmp/edited-changes-order.raw.capture.jsonl \
  --output-dir apps/desktop/e2e/fixtures/edited-changes-order \
  --scenario edited-changes-order \
  --backend codex \
  --thread-id <thread-id> \
  --source-capture-id <capture-id> \
  --start <sequence> \
  --end <sequence>
```

## Cleanup

After exporting the capture, discard or revert `tmp/edited-changes-ordering.ts`
so the disposable worktree returns to a clean state.
