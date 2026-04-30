# Plan Autocomplete Order Capture

This fixture is seeded from an existing protocol capture rather than a fresh
interactive run.

- Source checkout: `/Users/huntharo/github/PwrAgnt/apps/desktop`
- Capture root: `apps/desktop/.local/protocol-captures`
- Capture id: `2026-04-30T02-23-08-345Z-codex-full-access`
- Thread id: `019dde61-c9d6-70d2-9023-28669e27a63b`
- Evidence window: protocol sequences `65320..65572`

The captured visual regression was an active turn where earlier tool/file-change
activity from around 11:39-11:41 AM appeared below a later assistant commentary
message at 11:41 AM. The expected replay order is:

1. Active work group label.
2. Earlier command activity.
3. File-change activity.
4. Assistant commentary: focused composer tests are green.
5. Later Electron E2E command activity.
6. Assistant commentary: Chromium/contenteditable route is not enough.

The checked-in `raw.capture.jsonl` is a generated slice of the live capture, not
a hand-authored protocol transcript.
