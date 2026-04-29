# Review Output Rendering Capture

## Goal

Capture a Codex inline review that returns both:

- an `exitedReviewMode` item containing a plain-text review finding
- a duplicate `agentMessage` containing the same review text

The replay verifies that PwrAgnt renders the finding inside one review card and
does not render the duplicate assistant transcript message.

## Steps

1. Launch the desktop app with protocol capture enabled:

   ```bash
   PWRAGNT_PROTOCOL_CAPTURE=true \
   PWRAGNT_PROTOCOL_CAPTURE_ROOT=apps/desktop/.local/protocol-captures \
   pnpm dev
   ```

2. Open a Codex thread with an active worktree.
3. Run `/review` against `main`.
4. Stop after the review result is visible and the app has hydrated the thread.
5. Export the session capture for the reviewed thread id.

## Source Capture

- Capture id: `2026-04-29T01-22-48-920Z-codex-full-access`
- Thread id: `019dd682-56d6-7601-8634-fc3a49e67554`
