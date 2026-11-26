# Isolated reviewer runner (blind holdouts)

The local `review-matrix-driver.js` refuses candidate runs on blind cohorts because its review processes share the host filesystem and process context with the cohort, settled baseline findings, scoring files, and source checkout.

Use `isolated-review-controller.mjs` with the bundled `isolated-review-runner.js` to evaluate blind holdouts across both supported managed arms (`codex` and `neon`).

## Controller vs. runner boundary

- **Stays on the controller side:**
  - The cohort JSON file and all settled baseline findings, counts, buckets, and baseline reviewer identities.
  - Judge inputs and outputs (`<out>/scoring/`, `decision-output/`, `decision-batches-summary.json`).
  - Raw holdout logs (`<out>/raw-logs/<cellToken>.log`, mode `0o600`).
  - The candidate source checkout (`--repo`) and its full Git history and remotes.
- **Passed into each ephemeral runner cell:**
  - An opaque `cellToken` (never `caseId`, `bucket`, or baseline `backend`).
  - One minimal Git snapshot workspace checked out at detached `headCommit`, containing only `{mergeBase} ∪ (mergeBase..base) ∪ (mergeBase..head)` with `.git/shallow` boundaries, no reflogs, no alternates, no host paths, and `protocol.allow=never`.
  - For `neon`, the pinned `mergeBase..head` patch (`pwragent-eval-review.patch`) excluded via `.git/info/exclude`.
  - A strictly schema-validated `job.json` containing only the pinned PR snapshot (`prNumber`, `prUrl`, optional `prTitle`, `baseBranch`, `headBranch`, `baseCommit`, `headCommit`, `mergeBaseCommit`) and minimum review settings (`arm`, `model`, `reasoningEffort`, `timeoutMs`).

## Isolation controls

- **Default Access only:** `--allow-full-access` and `claude-native` are rejected. Codex runs with `executionMode: "default"`, `sandboxByMode: { default: "read-only" }`, `agentNetwork: false`. Neon runs with `mode: "plan"`, `fullAccess: false`, and `pinnedPatchFile`. Every approval request is declined.
- **Filesystem isolation:**
  - **macOS (`neon`):** Wraps the entire runner and `agy` process tree in `/usr/bin/sandbox-exec` (Seatbelt), denying reads across `/Users`, `/private/var/folders`, `/private/tmp`, the source repo (allowing only read-only `node_modules`), cohort dir, controller output dir, and any `--deny-path` roots, and denying writes across `/` except the cell's explicit writable state directories (`home`, `pwragent-home`, `result`, `tmp`, `.git/refs/pwragent`) and `/dev` null/tty nodes.
  - **macOS (`codex`):** Stages cells outside `/Users` and `/private/var/folders` with a minimal isolated `CODEX_HOME` (only `auth.json`/`.credentials.json` + empty `config.toml`), denies `job.json`, `result`, `bundle`, and `bin` plus all controller/home/temp roots via `codexProtectedRoots` with `agentNetwork: false`, and serializes cells to concurrency 1 so sibling cells never coexist in `/private/tmp`.
  - **Linux (`bwrap`):** Runs both arms inside a `bwrap` mount namespace with `cellRoot` mounted read-only (only explicit state directories writable), mounting non-`/usr` `codex` binaries read-only when present, and omitting host `/home`, source repo, cohort dir, controller output dir, and host `/tmp`.
  - **Container mode (`--isolation docker --docker-image <image>`):** Mounts `/eval` read-only with only explicit state directories (`home`, `pwragent-home`, `result`, `tmp`, `codex-home`, `workspace/.git/refs/pwragent`) mounted `:rw`, with `--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only`, and a unique container `--name` cleaned up via `docker rm -f` on timeout. Pass `--seccomp-profile <path>` when Codex bubblewrap runs inside Docker, and `--docker-node-path` if native addons live outside `/opt/outpost-tools/node_modules:/usr/local/lib/node_modules`. `build-eval-driver.mjs` emits the portable isolated bundle under `<dist>/isolated/` with pure-JS dependencies inlined and zero hardcoded host paths.
- **Git object history and remotes:** Pre-`mergeBase`, future `main`, unrelated branch, and tag commits are omitted from the staged object pack; `protocol.allow=never` in `.git/config` plus `GIT_ALLOW_PROTOCOL=""`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<devNull>`, and `GIT_TERMINAL_PROMPT=0` block all remote fetches and `ls-remote`.
- **Reviewer-accessible tools:** Strict allowlisted environment (strips `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `PWRAGENT_*`, API keys), high-precedence fail-closed shims blocking `gh`, `ssh`, `curl`, `wget`, and `git-remote-http*`, federation disabled, messaging disabled, `mcpProviderServersEnabled: false`, empty `CODEX_HOME/config.toml` and `mcp_config.json`, no prior sessions/brain/history/skills copied, and only the 4 in-memory managed review candidate ledger tools exposed.

## Build and verify isolation with synthetic canaries

Build the driver and isolated runner bundle from the candidate checkout, then run the built-in synthetic canary probe before touching a blind cohort:

```bash
skill=.agents/skills/managed-review-eval
work=.local/managed-review-eval

node "$skill/scripts/build-eval-driver.mjs" --repo "$PWD" --out "$work/dist"

node "$skill/scripts/isolated-review-controller.mjs" \
  --verify-isolation --arms codex,neon
```

`--verify-isolation` plants synthetic canaries for cohort files, settled baselines, judge inputs and outputs, raw holdout logs, source repo files, host `$HOME`, forbidden Git commits (pre-merge-base, future main, unrelated branch), Git remotes, `gh`, and forbidden environment variables, and proves every canary is unreadable from the reviewer environment for each requested arm.

## Run a blind cohort

Record the candidate commit, bundle digest, models, reasoning settings, and judge definitions before running a verified blind cohort. Run with `--cases all` (required for `blind: true`):

```bash
skill=.agents/skills/managed-review-eval
work=.local/managed-review-eval
cohort="$skill/cohorts/test-1.json"
run="$work/runs/test-1-candidate"

node "$skill/scripts/isolated-review-controller.mjs" \
  --repo "$PWD" \
  --dist "$work/dist" \
  --cohort "$cohort" \
  --out "$run" \
  --arms codex,neon \
  --concurrency 2
```

For blind cohorts, the controller prints aggregate totals only (`completed`, `failed`, `cancelled`, `timeout`, `skipped`), archives raw runner logs under `$run/raw-logs/` (mode `0o600`), deletes every ephemeral runner workspace immediately after each cell finishes, and writes controller-side results under `$run/results/<caseId>--<arm>.json` with pinned `baseCommit`, `headCommit`, and `mergeBaseCommit`. Re-running with identical settings resumes matching completed cells; pass `--force` to rerun.

Add `--deny-path <dir>` (repeatable) if additional holdout or scratch directories exist outside `$HOME`, `--repo`, `--cohort`, and `--out`.

## Score and aggregate the blind run

Score on the controller side using the same file-backed Decision workflow in [Scoring and aggregation](scoring.md). Blind cohorts require verified baseline ranges (never pass `--allow-legacy-baselines` or `--allow-inspect-test`):

```bash
scoring="$run/scoring"

node "$skill/scripts/prepare-scoring-batches.mjs" \
  --repo "$PWD" --cohort "$cohort" --results "$run/results" \
  --out "$scoring" --arms codex,neon --judge-provider openai

node "$skill/scripts/decision-file-batches.mjs" --scoring "$scoring"
# Invoke PwrAgent's decisions_invoke for each pending entry with inlineResults: false,
# keeping input and output file contents out of the tuning context.

node "$skill/scripts/decision-file-batches.mjs" --scoring "$scoring" --record

node "$skill/scripts/aggregate-eval-scores.mjs" \
  --cohort "$cohort" --results "$run/results" --scoring "$scoring" --out "$run"
```

Report only `aggregates` and `decisionScoring` from `$run/eval-matrix-summary.json`. Keep `$run/results/`, `$run/scoring/`, and `$run/raw-logs/` out of the tuning context.
