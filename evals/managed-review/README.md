# Managed Review Eval

Benchmarks PwrAgent's managed code review pipeline (`codex`, `neon`) and native provider baselines (`codex-native`, `claude-native`) on pinned `pwrdrvr/PwrAgent` pull-request snapshots (`dev-1`, `dev-2`, blind `test-1`, blind `test-2`).

## Run

```bash
# Single-case smoke test across managed Codex, native Codex review/start, and Antigravity Neon
pnpm eval:review -- --cohort dev-1 --cases pr4385-codex --arms codex,codex-native,neon --out evals/runs/smoke

# Full development cohort on current working tree
pnpm eval:review -- --cohort dev-1 --arms codex,codex-native,neon --out evals/runs/dev-1-current

# Benchmark an older git revision (for example v1.5.1 or main) without touching your working tree
pnpm eval:review -- --cohort dev-1 --rev v1.5.1 --arms codex,neon --out evals/runs/dev-1-v1.5.1

# Benchmark a candidate prompt variant without editing tracked files
pnpm eval:review -- --cohort dev-1 --prompt /tmp/guidance-variant.md --arms codex,neon --out evals/runs/dev-1-prompt-v2

# Run a blind holdout (automatically enforces OS-level isolation + aggregate-only reporting)
pnpm eval:review:verify-isolation -- --arms codex,codex-native,neon
pnpm eval:review -- --cohort test-1 --arms codex,neon --out evals/runs/test-1-candidate
```

### Safe workspace staging

Staged Git snapshots default to `/tmp/pwragent-eval-workspaces` (outside `$HOME`, `CODEX_HOME`/`~/.codex`, `PWRAGENT_HOME`, and macOS `/private/var/folders`), so running from a worktree inside `~/.codex/worktrees/...` never trips Outpost's Codex sandbox working-directory guard. Ephemeral workspaces are removed after each cell completes unless `--keep-workspaces` is passed.

### Antigravity Neon modes

- Default: `plan` mode + staged `pinnedPatchFile` (`pwragent-eval-review.patch`), with prompt guidance forbidding shell commands so `agy` stays on file-reading/search tools. Every approval request is still recorded in `approvalRequests` and `abortedOnApproval`.
- Under OS-enforced isolation (`--isolated` or blind cohorts, where macOS Seatbelt / Linux `bwrap` / Docker enforces read-only workspace and zero network), `--neon-mode auto` is optionally available.

## Score

Scoring defaults to PwrAgent's built-in **Jev** decision model (`--judge-provider jev`) and supports all PwrAgent decision providers: `jev`, `local` (Cloudflare Clef), `openai`, or `default` (operator's configured Settings default).

```bash
# Default (--mode mcp): prepares file-backed batches for PwrAgent's decisions_invoke proxy
# (caller needs NO API key; PwrAgent uses the key saved in Settings -> AI Providers)
pnpm eval:review:score -- --run evals/runs/dev-1-current --judge-provider jev

# Direct CLI mode (no interactive agent needed; local Clef works with zero API key)
pnpm eval:review:score -- --run evals/runs/dev-1-current --mode direct --judge-provider local
pnpm eval:review:score -- --run evals/runs/dev-1-current --mode direct --judge-provider jev
```

Scoring writes `eval-matrix-summary.json`, `summary.md`, and (for non-blind cohorts) `eval-matrix-findings-scored.csv`, surfacing:
- Addressed recall (exact and exact+partial) & declined-finding repetition
- New verified issues (`novel.concrete`) & unverified/invalid reports (`total - concrete`)
- Blinded holistic scores (`overallQuality`, `signalToNoise`, `actionability`)
- Wall-clock runtime (mean/median sec) & approval-abort count
- Observed context replays (cold, hot, total), token breakdown (uncached input, cached input, cache write, output, reasoning, total, peak context), and estimated list cost USD

## Compare runs

```bash
pnpm eval:review:compare -- v1.5.1=evals/runs/dev-1-v1.5.1 main=evals/runs/dev-1-main candidate=evals/runs/dev-1-prompt-v2
```

If any compared run is from a blind cohort (`"blind": true`), `compare` reports aggregate metrics only.
