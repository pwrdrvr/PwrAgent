# PwrAgent Evals

In-repo evaluation framework for benchmarking PwrAgent prompts, models, git revisions, and native provider baselines on pinned fixtures through repeatable repository commands.

| Suite | Command | Measures |
| --- | --- | --- |
| [managed-review](managed-review/README.md) | `pnpm eval:review` | Managed & native code reviews on pinned PR snapshots (`dev-1`, `dev-2`, blind `test-1`, blind `test-2`): recall, new verified issues, unverified/invalid reports, holistic quality, runtime, context replays, token breakdown, and list cost. |

Existing desktop live-app evals (`pnpm eval:smoke`, `pnpm eval:pdf`, and the Linux container driver) remain in [apps/desktop/eval/](../apps/desktop/eval/README.md).

## Quick start

```bash
# 1. Smoke-test one development case across managed Codex, native Codex, and Antigravity Neon
pnpm eval:review -- --cohort dev-1 --cases pr4385-codex --arms codex,codex-native,neon --out evals/runs/smoke

# 2. Score with PwrAgent's configured decision model (defaults to Jev; supports jev, local, openai, default)
#    --mode mcp (default): file-backed decisions_invoke proxy via PwrAgent (no API key needed in shell)
#    --mode direct: standalone CLI calls (works with local Clef at 127.0.0.1:8787 without a key, or Jev/OpenAI with env/proxy)
pnpm eval:review:score -- --run evals/runs/smoke --judge-provider jev

# 3. Compare two or more runs side-by-side (models, prompt variants, git revisions, native baselines)
pnpm eval:review:compare -- evals/runs/v1.5.1 evals/runs/main evals/runs/candidate

# 4. Run blind holdout isolation canary verification
pnpm eval:review:verify-isolation -- --arms codex,codex-native,neon
```

## Architecture & Boundaries

- **Top-level workspace (`@pwragent/evals`)**: Lives outside `packages/` so headless eval drivers can bundle `@pwragent/desktop` owner services without weakening `.dependency-cruiser.cjs`.
- **No paid runs in CI**: CI runs unit and property tests under `evals/**/__tests__/` (`pnpm test`) and enforces the Codex storage boundary (`pnpm lint:codex-storage`) and MIT license check (`pnpm licenses:check`).
- **Owner-API usage telemetry**: Token counts, cold/hot context replays, peak context, and list-cost estimates are read from PwrAgent's owner `readThread` pricing view—never by reading Codex-owned rollout/SQLite files.
- **Safe workspace staging**: Ephemeral review checkouts are staged outside `$HOME`, `CODEX_HOME` (`~/.codex`), `PWRAGENT_HOME`, and macOS `/private/var/folders` so worktrees under `~/.codex/worktrees/...` never trip Outpost's sandbox guard.
- **Blind holdout discipline**: Any cohort with `"blind": true` refuses non-isolated execution, routes through OS-level isolation (`sandbox-exec` / `bwrap` / Docker), and suppresses per-case and per-finding details in summaries and comparisons.
