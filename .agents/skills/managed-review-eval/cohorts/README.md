# Managed Review Evaluation Cohorts

These four disjoint 10-PR cohorts benchmark PwrAgent's managed code review system (`runMode: "pwragent-sub-agent"`) across real, fully settled `pwrdrvr/PwrAgent` pull requests.

## Split Discipline (Preventing Overfitting)

| Cohort | Split | Blind? | Cases | Baseline Findings (`A` / `D` / `X`) | Ref Survivability | Intended Use |
| --- | :---: | :---: | :---: | :---: | :---: | --- |
| `dev-1.json` | `dev` | No | 10 | `47` (`43` / `0` / `4`) | `8` `PERM_PR_ANCESTOR`, `2` `PERM_PR_TIP` | Primary tuning & error-analysis cohort |
| `dev-2.json` | `dev` | No | 10 | `32` (`29` / `0` / `3`) | `8` `PERM_PR_ANCESTOR`, `2` `PERM_PR_TIP` | Secondary tuning & error-analysis cohort |
| `test-1.json` | `test` | **Yes** | 10 | `30` (`27` / `1` / `2`) | `8` `PERM_PR_ANCESTOR`, `2` `PERM_PR_TIP` | **Held-out validation** before shipping prompt/harness changes — aggregate metrics only |
| `test-2.json` | `test` | **Yes** | 10 | `27` (`23` / `0` / `4`) | `7` `PERM_PR_ANCESTOR`, `3` `PERM_PR_TIP` | **Held-out lockbox** for major architectural changes or release verification |

*(Legend: `A` = operator-addressed, `D` = operator-deferred to a to-do card, `X` = operator-declined.)*

### Stratification Recipe (10 PRs per Cohort)
Every cohort shares the same balanced mix:
- `4` Codex native `/review` PRs with findings (`2` high-finding, `2` medium-finding)
- `2` Codex native `/review` clean PRs (`0` findings — tests specificity)
- `3` Claude `/code-review` PRs with findings (high operator acceptance)
- `1` Claude `/code-review` high-decline PR (`>= 2` declined findings — tests false-positive resistance)

## GitHub Ref Verification

Every single PR in all four cohorts (`40 / 40`) was verified against `origin` (`git ls-remote origin 'refs/pull/*/head'`):
1. `baseCommit` was an ancestor of `origin/main`.
2. `headCommit` was either identical to `refs/pull/<N>/head` (`PERM_PR_TIP`) or an exact ancestor of `refs/pull/<N>/head` (`PERM_PR_ANCESTOR`).
3. Dangling pre-force-push commits (`dangling_not_in_pr_tip`) are excluded during extraction.

The PR ref can retain the commit chain after branch deletion or a squash merge. A force-push can change which commits it retains. Follow [cohort maintenance](../references/cohort-maintenance.md) to recheck reachability without disclosing blind cases.

## Recorded Baseline Benchmark (`dev-1`, `origin/main` `165910030`)

Measured on 2026-11-25 with PwrAgent's PR #4394 in-memory candidate ledger + two-pass managed review prompt (`decisions_invoke` / `gpt-6-luna`, 208 items, `$0.0249` total).

The original review range could be confirmed for 21 of 40 historical cases. The remaining cases are marked `reviewedRangeVerified: false`. These splits retain their original membership. Use unverified development baselines for exploratory scoring and use newly verified cohorts for blind validation.

Treat the recorded precision and holistic columns as provisional until reproduced with verified ranges and anonymous judge inputs.

| Arm | Structured / Pending | Findings (Ledger `T→K/D`) | Mean Latency | Addressed Recall | Codex-Base Recall | Claude-Base Recall | Recorded Concrete Rate | Holistic SNR / Act / Overall |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Baseline (Codex / Claude) | `10/10` | `47` | — | ref (`43A/4X`) | ref (`23A`) | ref (`20A/4X`) | — | `3.43 / 3.08 / 3.26` |
| **Codex Managed** (`gpt-6.2-sol · xhigh`) | `10/10` / `0` | `57` (`67→57/10`) | `228s` | **48.8%** (`21/43`) | **52.2%** (`12/23`) | `45.0%` (`9/20`) | `61.4%` (`35/57`) | `3.36 / 3.41 / 3.62` |
| **Antigravity Neon Managed** (`gemini-4-neon · high`) | `10/10` / `0` | `27` (`28→27/1`) | `416s` | `39.5%` (`17/43`) | `26.1%` (`6/23`) | **55.0%** (`11/20`) | **74.1%** (`20/27`) | `3.40 / 3.72 / 3.48` |
| **Union (`Codex ∪ Neon`)** | — | — | — | **62.8%** (`27/43`) | — | — | — | — |
