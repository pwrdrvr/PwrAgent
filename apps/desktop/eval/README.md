# Live smoke eval (`pnpm eval:smoke`)

A **local, hands-off** end-to-end check that your real, installed agents work
through PwrAgent. It launches the real app (no mocked app-server), clones this
repo at a pinned SHA into a throwaway working dir, and drives each available
backend through a small matrix using the real preload IPC:

| Scenario | Mode | Pass condition |
| --- | --- | --- |
| "What is this project?" | Default Access | non-empty assistant answer |
| "Build the project" | Default Access | ≥1 approval request (auto-approved) |
| "Run one unit test" | Full Access | the turn completes |

It prints a pass/fail grid for Codex + every installed ACP agent
(Gemini / Grok / Kimi / Qwen) and exits non-zero if the core check ("what is
this project?") fails for any available backend.

This is **not** in CI — it needs your authenticated agents + Codex login and
hits real (paid, non-deterministic) models.

## Run it

```bash
# Build the app + native modules, then run the matrix:
pnpm eval:smoke:build

# If the app is already built (out/main/index.js exists), skip the rebuild:
pnpm eval:smoke

# Drive the real composer UI (validates the controls are actually presented):
pnpm eval:smoke:build:ui     # build + UI-drive
pnpm eval:smoke:ui           # UI-drive, no rebuild
```

### IPC-drive (default) vs UI-drive

By default the eval creates threads via the backend IPC — robust, exercises the
full real backend stack, and focuses each thread so you can watch it stream.

`EVAL_DRIVE_UI=1` (a.k.a. `pnpm eval:smoke:ui`) instead drives the real
**composer**: it opens the new-thread launchpad for the clone, asserts the
**Provider** dropdown offers the agent and selects it, asserts the **Access
mode** dropdown offers both Default + Full Access and selects the scenario's
mode (accepting the "Enable Full Access?" dialog), types the prompt, and clicks
**Start thread**. This validates the thing you'd otherwise hand-check — that the
options are actually presented and selectable. If any UI step fails it
screenshots to the captures dir and falls back to IPC creation, so the grid
still completes; the grid note is tagged `[UI]`, `[IPC]`, or `[IPC(fallback)]`.

## What it does and does NOT touch

- **Isolated** via `PWRAGENT_HOME=<tmp>` — a throwaway profile root. Your real
  PwrAgent profile, thread list, and settings are never touched.
- **Real auth preserved** — `HOME` is left alone, so Codex (`~/.codex`) and the
  ACP agents (`~/.gemini`, `~/.qwen`, `~/.kimi-code`, `~/.grok`) use their
  existing logins. The throwaway profile boots in shared mode (your default
  Codex).
- **Throwaway working dir** — the repo is cloned at a pinned SHA into
  `PwrAgent-Test` under a temp dir, so full-access command runs never touch your
  real checkout. (Cloned without `node_modules`; the "build"/"unit test"
  scenarios validate that the agent can *request/run commands*, not that the
  build is green.)
- **Cleaned up** on exit (pass `EVAL_KEEP_TEMP=1` to keep the dirs).

## What renders in the window

In the default **IPC-drive** mode the eval creates threads via `startThread`
rather than by driving the composer, so it does not animate the pre-thread
launchpad or the settings dropdowns — but it DOES focus each thread as it runs
(via the same `window:show-thread` navigation the menu/deep-links use), so you
can watch the transcript stream and approval prompts appear live.

For full UI fidelity — validating that the launchpad controls are actually
presented and selectable — use **UI-drive** mode (`EVAL_DRIVE_UI=1` /
`pnpm eval:smoke:ui`), described above.

## Transcript capture (feeds Phase B / KTD-P3)

Every run enables protocol capture (`PWRAGENT_PROTOCOL_CAPTURE=1`) and writes
raw ACP/Codex JSON-RPC transcripts — including ACP `session/update` — as JSONL
to a temp `captures/` dir, printed at the end. These are exactly the recordings
the KTD-P3 lossless-replay harness needs to prove the kit normalizer reproduces
the in-tree normalizer. Pass `EVAL_KEEP_TEMP=1` to retain them.

## Env knobs

| Var | Default | Meaning |
| --- | --- | --- |
| `EVAL_SHA` | current `HEAD` | commit to check out in the clone |
| `EVAL_BACKENDS` | all available | comma list, e.g. `codex,acp:gemini` |
| `EVAL_SCENARIOS` | all | comma list of `whatis,build,fulltest` |
| `EVAL_TURN_TIMEOUT_MS` | `180000` | per-turn timeout |
| `EVAL_STRICT` | off | non-zero exit if ANY scenario fails (not just `whatis`) |
| `EVAL_KEEP_TEMP` | off | keep the temp profile / clone / captures dirs |
| `EVAL_DRIVE_UI` | off | drive the composer UI instead of the IPC (`pnpm eval:smoke:ui`) |

```bash
# Just Codex + Gemini, only the "what is this?" probe, keep transcripts:
EVAL_BACKENDS=codex,acp:gemini EVAL_SCENARIOS=whatis EVAL_KEEP_TEMP=1 pnpm eval:smoke
```

## How it works (for maintainers)

- `lib/live-app.ts` — clones the repo, seeds a throwaway `default` profile
  (onboarding suppressed), launches the built app with `PWRAGENT_HOME` +
  protocol capture and **no** `PWRAGENT_REPLAY_FIXTURE_PATH` (so the real
  app-server runs, not the e2e mock).
- `lib/driver.ts` — drives `window.pwragent.*` via `page.evaluate`, runs an
  in-page `onAgentEvent` pump, waits for turn completion, and auto-approves
  permission requests using the shipping `buildPendingRequestResponse` (so the
  approve decision never drifts from the UI).
- `smoke.ts` — discovers backends (`listBackends`), registers the clone, runs
  the matrix, and prints the grid.

Typecheck locally with `pnpm --filter @pwragent/desktop eval:typecheck`. The
`eval/` dir is intentionally outside the app's typecheck/boundary gate, so it
never affects CI.
