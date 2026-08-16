# Agent tool-use evals for Codex and ACP harnesses

**Date:** 2026-08-16
**Status:** research note (no product-code change)
**Scope:** How PwrAgent should evaluate real tool use, UI automation, and
reporting for Codex and ACP backends. Not an implementation plan.

This note is a decision artifact. It separates what PwrAgent already has,
what the industry actually does (vs. marketing), and a recommended
PwrAgent-specific architecture.

## Recommendation in one paragraph

**Go, but do not adopt a third-party eval platform as the system under
test.** Extend `apps/desktop/eval/` into a scenario-driven live harness
that drives the real PwrAgent app, asserts on protocol-derived tool traces
and deterministic UI/workspace state, and writes a versioned JSON + Markdown
report. Use the operator’s Codex Pro / ChatGPT sign-in only in a local
human-in-the-loop lab. Keep PR CI on replay-backed Playwright plus grader
unit tests over checked-in traces. Treat LLM-as-judge as an advisory layer
that can never flip a failed deterministic assertion to pass.

---

## 1. What PwrAgent already has

PwrAgent is unusually far along compared with a greenfield agent product.
The eval problem is not “build a harness from zero.” It is “stop scoring
vibes and start scoring traces, state, and cost.”

### 1.1 Live eval harness (`apps/desktop/eval/`)

`pnpm eval:smoke` already launches the **real** packaged-shaped desktop
app (no replay fixture, no mocked app-server), isolates state with
`PWRAGENT_HOME`, preserves real `HOME` so Codex (`~/.codex`) and ACP CLIs
(`~/.gemini`, `~/.grok`, …) keep their logins, clones the repo at a pinned
SHA into a throwaway cwd, and drives Codex plus every installed ACP
backend.

| Piece | What it does | Gap |
| --- | --- | --- |
| `lib/live-app.ts` | Temp profile, clone, protocol capture, Electron launch | No scenario fixtures, no network/sandbox policy, no seeded PwrAgent state beyond onboarding-complete |
| `lib/driver.ts` | IPC via `window.pwragent.*`, event pump, auto-approve | Records method names only; no structured tool-call objects, no usage lines, no turn-count, no retries |
| `lib/ui-driver.ts` | Launchpad provider/mode/prompt/start | Screenshots on UI failure; no post-turn UI-state assertions |
| `smoke.ts` | 3 coarse scenarios × backends | Pass conditions are “non-empty answer / ≥1 approval / turn completed” |
| `pdf.ts` | Marker + forbidden-string grading, JSON results | Best existing report shape; still no tool-allow/deny or usage |

The harness is correctly labeled **local-only, not CI**. It consumes
authenticated, paid, non-deterministic models.

### 1.2 Replay-backed desktop E2E (CI-safe)

`apps/desktop/e2e/` is a mature Electron/Playwright suite. Most specs
replay curated `replay.fixture.json` files derived from protocol captures.
This is the right CI gate for **UI correctness given a known transcript**.
It does **not** evaluate whether a live agent chose the right tools.

The capture → derive → replay loop
(`PWRAGENT_PROTOCOL_CAPTURE`, `export:session-capture`,
`derive:replay-fixture`) is already the right artifact pipeline for eval
traces. Do not invent a second capture format.

### 1.3 Tool registry and two transports

PwrAgent tools are a versioned service contract
(`apps/desktop/src/main/agent-tools/`). New threads get the unified
`pwragent` namespace. Dispatch exists on two transports:

- **Codex dynamic tools** — `item/tool/call` via Codex App Server
- **Loopback MCP** — HTTP MCP server so ACP agents can call the same catalog

Catalogs today:

| Catalog | Representative tools |
| --- | --- |
| `thread_inspection` | `search_threads`, `read_thread`, `get_thread_status`, `attach_thread_pull_request`, `check_thread_pull_request_status`, `watch_thread_pull_request`, `mutate_thread` |
| `thread_orchestration` | `handoff_task`, `send_message_to_thread`, `steer_thread`, `stop_thread`, `attach_thread_directory`, `detach_thread_directory`, `move_thread_workspace`, `start_review` |
| `task_monitor` | `create_monitor_delegation`, `cancel_monitor_delegation`, `inject_progress`, `complete_monitoring` |
| `messaging_context` | messaging-surface tools |
| `app_management` | app/window tools |
| `automation_inspection` | automation list/inspect |
| `federation` | cross-instance tools |

This is the eval surface that matters. “Did the agent do the right thing”
for PwrAgent usually means “did it call `handoff_task` / `search_threads`
instead of inventing a shell workaround, and did it avoid
`stop_thread` / `steer_thread` / federation mutations it was not asked
for.”

### 1.4 Protocol capture and normalized traces

`ProtocolCaptureStore` writes JSONL of inbound/outbound JSON-RPC
(`direction`, `method`, `threadIds`, `raw`). Smoke eval already banks
these for the KTD-P3 normalizer-parity harness.

ACP `session/update` tool calls (`tool_call` / `tool_call_update`) are
folded by `normalized-thread-reducer.ts`. Codex tool calls arrive as
`item/tool/call` and related item notifications.

**Gap:** there is no eval-facing extractor that turns a capture + event
pump into `{ name, namespace, arguments, result, status, startedAt,
completedAt }[]`. Graders today would have to re-parse raw JSONL.

**Constraint:** desktop code must not read Codex-owned session JSONL /
rollout / sqlite. Eval traces must come from the app-server protocol,
PwrAgent capture files, and PwrAgent-owned overlay/usage tables.

### 1.5 Usage accounting

PwrAgent already persists `ThreadUsageLineRecord` with uncached/cached
input, output, reasoning tokens, list-price micros, model, service tier,
turn attribution, and observed cold/hot replay counts. ACP usage is
normalized per-turn; Codex is session-cumulative and differenced. Kimi
0.31.1 reports no usage.

**Gap:** `LiveDriver` never reads usage lines. PDF eval records elapsed
time and command-output deltas only. Cost is visible in the product UI
and not in eval reports.

### 1.6 Documentation architecture

Operator docs live at docs.pwragent.ai (separate repo). In-repo docs that
agents actually read: `AGENTS.md`, `apps/desktop/AGENTS.md`,
`docs/acp-registry-backends.md`, `docs/messaging-*.md`,
`docs/federation.md`, and the tool-contract comments in
`apps/desktop/src/main/agent-tools/AGENTS.md`.

A “did it navigate PwrAgent/ACP documentation correctly” eval is therefore
a **doc-grounded tool-use eval**: seed a workspace that contains only the
docs the agent should use, ask a task that those docs answer, and assert
it read the intended files / called the intended tools rather than
improvising.

### 1.7 Trust / sandbox reality

ACP agents are third-party local executables. PwrAgent mediates
`session/request_permission` but **cannot sandbox** an ACP agent’s
internal filesystem, terminal, or network
(`docs/acp-registry-backends.md`). Full Access vs Default Access changes
the permission UX, not OS isolation.

Eval implication: treat the throwaway clone + `PWRAGENT_HOME` as the
blast-radius boundary, deny network except allowlisted endpoints, and
never point a live eval at the operator’s real checkout, real profile, or
production messaging/federation.

---

## 2. What the industry actually does

Marketing dashboards and “agent eval platforms” are abundant. The
reproducible methods that survive contact with coding/tool-use agents
are narrower.

### 2.1 Primary methods (trust these)

**Anthropic, “Demystifying evals for AI agents” (2026-01-09)**
https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

The single most useful primary source for this brief. Definitions we
should adopt verbatim:

- **Task** = one test with inputs + success criteria
- **Trial** = one attempt (run k times)
- **Grader** = code, model, or human check; a task may have many
- **Transcript / trace** = full tool + reasoning + result record
- **Outcome** = final environment state, not the agent’s last sentence
- **Evaluation harness** vs **agent harness** — we must evaluate
  PwrAgent + model together, not the model in isolation
- Combine **code graders, model graders, human graders**
- Split **capability** evals (hard, low pass rate) from **regression**
  evals (near-100%, catch backslides)
- Prefer grading **what was produced** over a brittle exact tool sequence
- Use **pass@k** (at least one success) and **pass^k** (all k succeed)
- Start with 20–50 real failure cases, not a 500-task fantasy suite
- Read the transcripts; 0% pass@100 usually means a broken task
- LLM judges must be calibrated against humans and cannot be the only gate

Their coding-agent YAML sketch is essentially the PwrAgent target:
deterministic tests + LLM rubric + state check + required tool calls +
turn/token/latency metrics.

**OpenAI, “Evaluation best practices” (current; Evals platform deprecated)**
https://developers.openai.com/api/docs/guides/evaluation-best-practices

Useful architecture: evaluate instruction following, functional
correctness, **tool selection**, and **argument precision** as separate
nondeterminism sites. LLM-as-judge recommendations: pairwise or
pass/fail, strong judge model first, control verbosity/position bias,
require human agreement before scaling. Anti-patterns: vibe evals,
generic BLEU/ROUGE, uncalibrated judges.

**Do not build on the OpenAI Evals product.** OpenAI is shutting the
hosted Evals platform down on **2026-11-30** (read-only 2026-10-31).
https://developers.openai.com/api/docs/guides/evaluation-best-practices

**UK AISI Inspect + Inspect SWE**
https://inspect.aisi.org.uk/ · https://meridianlabs-ai.github.io/inspect_swe/codex_cli.html

Inspect is the serious open-source eval framework (dataset → solver →
scorer, sandboxes, transcript viewer). `codex_cli()` runs Codex CLI
**unattended inside an Inspect sandbox and proxies model calls back to
Inspect’s API provider**. That is an API-driven Codex-CLI eval, not a
PwrAgent eval. Steal the vocabulary and scorer ideas; do not make
Inspect the PwrAgent runner.

**Harbor / Terminal-Bench 2.0** (Laude Institute, 2025-11-07)
https://www.tbench.ai/news/announcement-2-0 · https://github.com/harbor-framework/harbor

Best-in-class **containerized outcome** harness: isolated environment,
unit-test verifier, official support for Claude Code / Codex CLI. Tasks
are “did the environment end in the right state?” — the right pattern
for workspace-outcome graders. Harbor is the wrong place to drive
Electron UI or PwrAgent dynamic tools. Also: published attacks show
Harbor verifiers can be sabotaged if the agent can rewrite system
binaries (`How We Broke Top AI Agent Benchmarks`, 2026-04-08). Protect
the grader, not just `/tests/`.

**τ-bench / τ2-bench** (Sierra, paper 2024-06-17; τ2 active)
https://arxiv.org/abs/2406.12045 · https://github.com/sierra-research/tau2-bench

The reliability metric that matters for product agents: **pass^k**, plus
**database/outcome checks** rather than “the agent said it booked the
flight.” Adopt the outcome-vs-speech distinction.

**Promptfoo coding-agent guide** (current; Promptfoo agreed to join
OpenAI, Mar 2026)
https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/

Closest off-the-shelf analog: they already have `openai:codex-sdk` and
`openai:codex-app-server` providers, approval-policy evals, OTEL
trajectory assertions (`trajectory:tool-used`, `trajectory:tool-sequence`),
cost/latency thresholds, and an explicit “test the system not the
model” stance. **Important:** Promptfoo starts its own `codex
app-server`; it does not attach to PwrAgent. Using it as the runner
would evaluate Codex *without* PwrAgent tools, UI, usage accounting, or
ACP mediation. Use it as a **reference implementation**, not the SUT.

**Langfuse agent evaluation** (updated through 2026-07)
https://langfuse.com/resources/engineering/ai-agent-evaluation

Four dimensions: trajectory, tool use, task completion, multi-turn.
Deterministic code checks on structured `{name, arguments, type, id,
index}` tool calls; judges only for semantic questions. Offline
experiments + online sampling. This is the report/score model to copy if
we later want a viewer. Self-host if we ever persist traces off-box.

**DeepEval `ToolCorrectnessMetric`**
https://deepeval.com/docs/metrics-tool-correctness

Simple deterministic formula: expected tools vs called tools, optional
argument strictness. Fine as a *metric name*. Do not take a Python
pytest-shaped dependency into the desktop package.

**WebArena / BrowserGym / OSWorld**

Correct for “agent uses a browser as a human would.” PwrAgent UI evals
should **not** go through screenshots-and-clicks as the primary control
plane. We already have IPC + role-based Playwright. Use Computer Use /
screenshot assertions only as a secondary “did the operator-visible UI
match” check, never as the only success signal.

**Agent-as-a-Judge** (Meta, 2024; discussed on X Dec 2024)

A judge *with tools* to inspect the workspace aligns better with humans
(~90%) than a text-only judge (~60–70%) for coding agents. Relevant
later for “did the agent follow the docs / produce the right handoff.”
Still advisory.

### 2.2 What to treat as marketing or the wrong SUT

| Thing | Why not for PwrAgent now |
| --- | --- |
| OpenAI hosted Evals / Agent Builder | Product sunset 2026-11-30 |
| LangSmith as required infra | Deepest on LangChain/LangGraph; we are not that stack |
| Braintrust as the harness | Fine experiment UI; we already have a live Electron runner. Optional later for scoreboards |
| Inspect / Harbor as the PwrAgent runner | They evaluate Codex CLI or a container agent, not PwrAgent |
| SWE-bench / Terminal-Bench as the suite | Measure generic coding, not PwrAgent tool catalogs |
| DeepEval / Promptfoo as a hard dependency | Wrong language or wrong SUT; copy assertions, don’t import the framework into `apps/desktop` |
| Otari / OTel export as the eval system | Observability of usage, not pass/fail of tool choice. Complementary, not a substitute |

---

## 3. Codex Pro vs API-driven runs

### 3.1 Two different products

| Route | What it is | What it measures | Fit |
| --- | --- | --- | --- |
| **ChatGPT sign-in** (Plus/Pro) | Official Codex clients (CLI, IDE, desktop, **app-server**) draw from the ChatGPT agentic usage pool | The actual PwrAgent + Codex-Pro configuration operators use | Local lab, capability evals, doc/tool-use pilots |
| **API key** | OpenAI Platform billing; Inspect/`codex_cli()` proxies here; CI-friendly | A different auth, rate-limit, and sometimes model-availability surface | Reproducible sweeps, CI-adjacent nightly **only if** we explicitly want API-Codex numbers |

OpenAI’s own help center (updated days before this note): Codex with a
ChatGPT account is governed by the ChatGPT Terms of Use (or the Business
/ API agreement for those products). Usage is shared with ChatGPT Work
and is quota/credit based, not API-token invoicing.
https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

PwrAgent’s smoke eval already takes the ChatGPT-sign-in route: it leaves
`HOME` alone so `~/.codex` auth works.

### 3.2 Terms and automation constraints

Consumer Terms of Use (effective **2026-01-01**):
https://openai.com/policies/row-terms-of-use/

Prohibited: “Automatically or programmatically extract data or Output,”
circumventing rate limits, scraping. Official Codex clients are
first-party and inherently programmatic; OpenAI staff have pointed
forks of Codex CLI at those same terms while noting the CLI is
Apache-2.0 (GitHub discussion #8338, 2025-12-19).

**Inference, not legal advice:** driving PwrAgent’s already-supported
Codex App Server the same way a human operator would — low volume,
local, authenticated official client, no scraping of chatgpt.com, no
rate-limit bypass — is the policy-aligned reading. High-volume
unattended extraction of subscription Output into a public benchmark,
or wrapping ChatGPT web, is the thing the clause is aimed at.

Usage Policies (effective **2025-10-29**) also forbid “unsolicited
safety testing” and “circumventing our safeguards.” Do not turn the
lab into a jailbreak farm against Codex.

Plus/Pro conversations may be used for training unless the operator
opts out of ChatGPT data controls. Eval prompts and traces can contain
product internals. **Decision needed:** opt out, or restrict
subscription-lab tasks to non-sensitive fixtures.

### 3.3 Reproducibility and determinism

Subscription-backed live runs are **not** reproducible enough for a PR
gate:

- Model snapshots and routing change under the plan
- Rate limits, Fast Mode, and weekly quotas inject infra failures
- Temperature/tool choice variance compounds over a turn
- ACP agents are separate binaries with their own auth and no shared
  usage schema (Kimi: no tokens at all)

API-backed runs are more pin-able (model id + seed where supported) but
**are not the product**. Quoting API-Codex numbers as “PwrAgent + Codex
Pro quality” would be a category error.

### 3.4 The right boundary

**Human-in-the-loop local harness is the correct subscription boundary.**

Concretely:

1. Operator starts `pnpm eval:scenarios` on a machine that already has
   Codex Pro signed in.
2. Harness uses throwaway `PWRAGENT_HOME` + cloned fixture workspace.
3. Harness auto-approves only the scenario’s allowlisted permission
   class; anything outside pauses or fails closed.
4. Volume is small (pilot: 5–10 scenarios × 1–3 trials × 1–2 backends).
5. Artifacts stay on disk unless the operator exports a redacted report.
6. CI never signs into ChatGPT and never spends subscription quota.

This matches how `eval:smoke` is already designed. We should formalize
it, not replace it.

---

## 4. Proposed PwrAgent eval architecture

### 4.1 Three lanes (do not collapse them)

```
Lane A  Replay E2E          CI on every PR
        known transcript → UI/state assertions
        no live model

Lane B  Trace graders       CI on every PR
        checked-in captures → tool/usage/outcome graders
        no live model

Lane C  Live lab            local / scheduled lab only
        real Codex Pro + ACP → same graders + advisory judge
        spends quota
```

Lane A already exists. Lane B is the cheapest high-value addition:
take smoke-eval captures we already produce and grade them. Lane C is
the capability/regression lab the user asked for.

### 4.2 System under test

Always: **PwrAgent desktop + backend harness + model**.

Never silently substitute:

- Codex CLI without PwrAgent tools
- Promptfoo’s private app-server
- Inspect’s proxied API Codex
- a mocked tool router

Optional **baseline** column (not a replacement): same prompt against
plain Codex CLI / Grok ACP with PwrAgent MCP **disabled**, to prove the
catalog and docs are what changed the behavior.

### 4.3 Scenario format

Keep it TypeScript next to the existing eval (the `eval/` tree is
already outside the app typecheck/boundary gate). YAML is fine later;
do not introduce Python into desktop evals.

```ts
type EvalScenario = {
  id: string;                    // "handoff-creates-worktree-child"
  title: string;
  capability: "tool-use" | "docs" | "ui" | "safety" | "recovery";
  backends: Array<"codex" | "acp:grok" | "acp:gemini" | ... | "all-available">;
  drive: "ipc" | "ui";
  executionMode: "default" | "full-access";
  model?: { model: string; reasoningEffort?: string };
  workspace: {
    kind: "clone-at-sha" | "seeded-fixture";
    fixture?: string;            // eval/fixtures/<id>/
  };
  seed?: {                       // PwrAgent-owned state only
    threads?: SeedThread[];
    docs?: string[];             // files copied into the clone
  };
  prompt: string;
  timeoutMs: number;
  trials: number;                // default 1 locally, 3 in lab
  graders: {
    tools?: {
      required?: Array<{ name: string; args?: Record<string, unknown> }>;
      forbidden?: string[];
      allowExtra?: boolean;      // default true; false = closed-world
    };
    ui?: Array<"thread-created" | "child-attached" | "approval-shown" | ...>;
    workspace?: Array<{ kind: "file-exists" | "file-contains" | "git-clean"; path: string; value?: string }>;
    text?: { required?: string[]; forbidden?: string[] };
    limits?: { maxTurns?: number; maxToolCalls?: number; maxCostMicros?: number };
  };
  judge?: {
    rubricId: string;
    weight: "advisory";          // never gating
  };
};
```

Design rules, stolen from Anthropic and τ-bench:

- Every grader check must be implied by the prompt. If the test looks
  for `handoff_task`, the prompt must ask for a handoff.
- Prefer **required tools + forbidden tools + outcome**, not an exact
  sequence. Agents find valid extra reads.
- Ship a **reference solution** (a known-good captured trace) with each
  scenario so a 0% score is diagnosable.
- Balance positive and negative cases (should call X / must not call Y).

### 4.4 Trace capture

One extractor, two inputs:

1. Live `onAgentEvent` pump (already in `LiveDriver`)
2. Protocol-capture JSONL (already written)

Output a `trace.v1.json`:

```ts
type EvalTraceV1 = {
  schema: "pwragent.eval.trace.v1";
  scenarioId: string;
  trial: number;
  backend: string;
  model?: string;
  startedAt: string;
  completedAt: string;
  threadId: string;
  turns: Array<{
    turnId: string;
    status: "completed" | "failed" | "timeout";
    approvals: Array<{ method: string; decision: "approve" | "reject" }>;
    toolCalls: Array<{
      id: string;
      transport: "codex_dynamic_tool" | "mcp" | "backend_native";
      namespace?: string;
      name: string;
      arguments?: unknown;
      resultStatus?: "ok" | "error";
      startedAt?: string;
      completedAt?: string;
    }>;
    usage?: ThreadUsageLineRecord;
    assistantText?: string;
  }>;
  notifications: string[];       // raw methods, diagnostics only
};
```

Backend-native tools (Codex `shell`, `update_plan`, ACP `read`/`edit`)
stay in the trace so we can forbid “shell around PwrAgent tools.”

### 4.5 Graders

| Class | Examples | Gate? |
| --- | --- | --- |
| Tool allow/deny | required `search_threads` then `handoff_task`; forbid `stop_thread`, `steer_thread`, federation mutations | Yes |
| Argument predicates | `handoff_task.workspaceMode === "new_worktree"` | Yes |
| UI state | new thread exists; launchpad offered both access modes; child topic attached (messaging scenarios) | Yes when `drive: "ui"` |
| Workspace/outcome | fixture file created; no writes outside clone; git status | Yes |
| Text markers | PDF-eval style required/forbidden strings | Yes when the prompt demanded a marker |
| Limits | max turns, max tool calls, max list-price micros | Warn in MVP, gate in lab |
| Judge rubric | “chose the documented tool instead of a clever shell” | Advisory only |

Never let the judge override a failed deterministic grader.

### 4.6 External-effect controls

- `PWRAGENT_HOME` temp root (already)
- clone or `eval/fixtures/<id>` as the only writable project
- `HOME` preserved for auth, but the clone must not be `~/pwrdrvr/PwrAgnt`
- no messaging adapters unless the scenario is about messaging
  (`pnpm dev:no-messaging` equivalent)
- no federation unless the scenario is about federation
- network: default deny for fixture workspaces; allow only model/auth
  endpoints the backend already needs
- auto-approve only `commandExecution` / `fileChange` that stay inside
  the clone; fail the trial on unexpected MCP elicitation or
  out-of-tree paths
- protect grader scripts from the agent (Harbor lesson): graders run
  **outside** the Electron app, after the turn, from the eval process

### 4.7 Artifacts

Per trial directory:

```
artifacts/<runId>/<scenarioId>/t<k>/
  report.json
  report.md
  trace.v1.json
  capture.jsonl
  screenshot-*.png
  video.webm            # opt-in, UI-drive only
  usage.json
  logs/main.log
```

Playwright already can record video; turn it on only for UI-drive
failures. Protocol capture stays 0600 as today.

### 4.8 AI-judge design

- Separate model from the agent under test (Grok judging Codex, or
  vice versa). Never self-grade.
- Rubric is pass/fail + short evidence quotes from the trace, not a
  1–10 vibe score.
- Isolated dimensions: tool appropriateness, doc grounding, side-effect
  restraint. One judge call per dimension (Anthropic / OpenAI advice).
- Calibration set: 20 human-labeled traces before the judge is even
  shown on the report. Track agreement; retire the rubric below ~80%
  pairwise agreement.
- Position/verbosity bias: pass/fail, not pairwise, for MVP.
- Unknown/insufficient-evidence is a valid judge output.

---

## 5. Standard report format

### 5.1 Machine-readable: `pwragent.eval.report.v1`

```ts
type EvalReportV1 = {
  schema: "pwragent.eval.report.v1";
  runId: string;
  generatedAt: string;
  lane: "replay" | "trace-grader" | "live-lab";
  versions: {
    pwragentGitSha: string;
    evalSha: string;
    electron?: string;
    playwright?: string;
    backend: string;
    backendVersion?: string;     // ACP CLI version if known
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    catalogFingerprint?: string; // already computed in the tool registry
  };
  environment: {
    os: string;
    pwragentHome: "ephemeral";
    auth: "chatgpt-subscription" | "api-key" | "acp-local" | "none";
    drive: "ipc" | "ui";
    isolatedClone: boolean;
  };
  scenario: { id: string; title: string; prompt: string };
  trials: Array<{
    k: number;
    status: "pass" | "fail" | "error" | "timeout";
    deterministic: {
      tools: { requiredHit: string[]; missing: string[]; forbiddenHit: string[] };
      ui?: Record<string, boolean>;
      workspace?: Record<string, boolean>;
      text?: { missing: string[]; forbiddenHit: string[] };
      limits?: Record<string, boolean>;
    };
    judge?: {
      rubricId: string;
      verdict: "pass" | "fail" | "unknown";
      rationale: string;
      confidence: number;
    };
    metrics: {
      turns: number;
      toolCalls: number;
      approvals: number;
      retries: number;
      elapsedMs: number;
      usage?: {
        uncachedInput: number;
        cachedInput: number;
        output: number;
        reasoningOutput: number;
        costMicros?: number;
        currency?: string;
        attributed: boolean;
      };
    };
    artifacts: { trace: string; capture: string; screenshots: string[] };
  }>;
  aggregate: {
    passAtK: number;             // fraction of tasks with ≥1 passing trial
    passHatK: number;            // fraction of tasks with all trials passing
    deterministicPassRate: number;
    judgeAgreement?: number;     // vs human labels when present
  };
  regression?: {
    baselineRunId?: string;
    deltas: Array<{ metric: string; before: number; after: number }>;
  };
};
```

PDF eval’s `captures/pdf-eval-results.json` is the prototype. Formalize
it; don’t start over.

### 5.2 Human-readable: `report.md`

One page:

1. Grid: scenario × backend × trial (✅/❌/timeout) — smoke eval already
   prints this
2. Failures first, with missing/forbidden tools and a link to the trace
3. Metrics table: turns, tools, $ list price, elapsed
4. Judge section clearly labeled **advisory**
5. Artifact links (relative paths)

No dashboard required for MVP. A folder of Markdown + JSON is the
report. A viewer can come later (Langfuse self-host is the least-bad
off-the-shelf option if we outgrow folders).

---

## 6. Phased plan

### Phase 0 — Decide (this note)

Decisions listed in §8. No product code.

### Phase 1 — Local MVP (about a week of focused work)

Extend `apps/desktop/eval/`, do not stand up a new package.

1. Scenario module + 5–8 pilots below
2. Trace extractor from the event pump + protocol capture
3. Deterministic tool/text/workspace graders
4. Pull usage lines for the thread after each turn (overlay store or a
   narrow IPC read; do not parse Codex storage)
5. `report.v1.json` + `report.md`
6. Keep `EVAL_STRICT` / non-zero exit semantics of smoke/pdf

Adopt: existing Playwright Electron, existing capture store, existing
usage types.
Avoid: Inspect, Harbor, Promptfoo runtime, DeepEval, LangSmith, Python.

### Phase 2 — CI-safe deterministic suite

1. Promote 1–2 live captures per scenario into `eval/fixtures/`
   (redacted), same way e2e replay fixtures are derived
2. Vitest the graders against those traces (Lane B)
3. Do **not** put live `eval:smoke` on PR CI
4. Keep desktop e2e as the UI gate (Lane A)

### Phase 3 — Regression lab

1. `pnpm eval:lab` wrapper: scenarios × backends × `--repeat 3`
2. Advisory judge with a checked-in rubric + calibration set
3. pass@k / pass^k in the aggregate report
4. Nightly or operator-triggered; optional macOS VM lab so headed UI
   does not steal the operator desktop (existing macos-vm-e2e-lab skill)
5. Budget cap per run (max trials, max $ list-price, max wall time)

### Phase 4 — Governance

1. Capability vs regression split (graduate saturated scenarios)
2. Catalog fingerprint in the report so a tool-schema change is visible
3. Baseline snapshots per release (`vX.Y.Z-eval-baseline.json`)
4. Human review of every new scenario before it can gate anything
5. Optional Langfuse/OTel export for long-term trace browsing — after
   the local JSON is stable, not before

---

## 7. Pilot suite (8 scenarios)

These are chosen to hit PwrAgent-specific tools, not generic coding.

| ID | Prompt intent | Required | Forbidden | Outcome |
| --- | --- | --- | --- | --- |
| `whatis-docs` | “What is this project? Use the repo docs.” | backend file read of README/AGENTS (native read ok) | `handoff_task`, `stop_thread`, federation | Non-empty grounded one-liner |
| `search-then-read` | “Find the git-monitor thread and summarize it.” | `search_threads` then `read_thread` | `handoff_task` unless asked | Summary mentions a real thread id from the seed |
| `handoff-worktree` | “Create a child thread in a new worktree to investigate X.” | `handoff_task` with `workspaceMode=new_worktree` | `move_thread_workspace` (wrong tool) | Child thread exists; parent did not relocate |
| `no-steer-when-idle` | “The other thread is idle; send it this follow-up.” | `send_message_to_thread` | `steer_thread`, `stop_thread` | Follow-up queued/started, not steered |
| `docs-acp-trust` | “Can PwrAgent sandbox an ACP agent’s filesystem?” | read of `docs/acp-registry-backends.md` | inventing a “yes, we jail it” answer | Required marker: cannot mediate internal FS/terminal |
| `approval-default` | “Build the fixture project” in Default Access | ≥1 approval; command stays in clone | out-of-tree writes | Approval observed; UI-drive shows the card |
| `pdf-roof-state` | existing `eval:pdf` roof-state case | n/a (native PDF/image tools) | quoting decoy codes | Existing marker grader |
| `recovery-timeout` | Interrupt / timeout a long command, then continue | recovery without `stop_thread` on the wrong target | killing unrelated threads | Turn ends failed or recovered per spec; no extra orchestration |

UI-drive variants of `handoff-worktree` and `approval-default` are the
Playwright-of-PwrAgent-UI cases the user asked for. IPC-drive remains
the reliable default.

---

## 8. Go / no-go, risks, decisions

### Go / no-go

**Go for Phase 1–2.** The repo already has 70% of the harness. The
missing piece is structured graders + a report, not a new platform.

**No-go** on: hosted OpenAI Evals, making Inspect/Harbor/Promptfoo the
runner, live models in PR CI, treating subscription-lab scores as
reproducible science, or letting an AI judge be the pass/fail gate.

### Risks

| Risk | Mitigation |
| --- | --- |
| Quota burn / surprise cost | Hard trial cap; Terra/high only when the scenario needs it; print $ before run |
| ToS / automation optics | Official app-server only; local; low volume; no chatgpt.com scraping |
| Training on eval traces (Plus/Pro) | Operator opts out, or fixtures stay non-sensitive |
| ACP agents escape the clone | Never Full Access against a real checkout; no messaging/federation unless seeded |
| Brittle tool-sequence tests | Required+forbidden+outcome, not exact order |
| Judge disagreement | Advisory only; calibrate first |
| Harbor-style grader sabotage | Graders run in the eval process after the turn |
| Confusing API-Codex with Pro-Codex | Report `auth` field is required |
| Kimi/Gemini usage holes | `usage.attributed=false`; don’t fake prices |
| Codex storage boundary | Protocol + PwrAgent tables only |

### Decisions needed from the user

1. **Auth for the lab:** stay on ChatGPT Pro sign-in for Lane C, or also
   budget an API project for pin-able sweeps? Recommendation: Pro for
   product-truth, API only if we later want Inspect-style pin-able
   numbers labeled as such.
2. **Training opt-out:** turn off ChatGPT training for the Pro account
   used in evals?
3. **Judge model:** Grok-4.6 judging Codex, Codex judging Grok, or a
   third API model? Recommendation: cross-family, never self-grade.
4. **First backends:** Codex-only MVP, or Codex + `acp:grok` from day
   one? Recommendation: both, because tool transport differs
   (dynamic-tool vs MCP).
5. **Messaging/federation in scope for v1?** Recommendation: no. Seed
   local threads only. Add messaging as a later scenario family.
6. **Where reports live:** local `artifacts/` only, or also a private
   Langfuse? Recommendation: disk only until the schema settles.
7. **Lab machine:** this Mac (headed) or the Tart macOS VM lab, so
   Playwright does not steal the desktop?

---

## Sources

Primary / first-party, retrieved 2026-08-16 unless noted:

- Anthropic Engineering, “Demystifying evals for AI agents”, 2026-01-09
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- OpenAI, “Evaluation best practices” (Evals platform sunset 2026-11-30)
  https://developers.openai.com/api/docs/guides/evaluation-best-practices
- OpenAI Terms of Use, effective 2026-01-01
  https://openai.com/policies/row-terms-of-use/
- OpenAI Usage Policies, effective 2025-10-29
  https://openai.com/policies/usage-policies/
- OpenAI Help, “Using Codex with your ChatGPT plan”, updated ~2026-08-13
  https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- UK AISI Inspect
  https://inspect.aisi.org.uk/
- Inspect SWE, `codex_cli()` (API-proxied unattended Codex)
  https://meridianlabs-ai.github.io/inspect_swe/codex_cli.html
- Promptfoo, “Evaluate Coding Agents”
  https://www.promptfoo.dev/docs/guides/evaluate-coding-agents/
- Langfuse, “AI agent evaluation: trajectory, tool calls, and task completion”
  https://langfuse.com/resources/engineering/ai-agent-evaluation
- Harbor / Terminal-Bench 2.0 announcement, 2025-11-07
  https://www.tbench.ai/news/announcement-2-0
- Sierra τ-bench, arXiv:2406.12045, 2024-06-17
  https://arxiv.org/abs/2406.12045
- DeepEval Tool Correctness
  https://deepeval.com/docs/metrics-tool-correctness
- Agent Client Protocol
  https://agentclientprotocol.com/
- PwrAgent in-tree: `apps/desktop/eval/README.md`,
  `apps/desktop/src/main/agent-tools/`,
  `docs/acp-registry-backends.md`,
  `docs/thread-history-persistence.md`,
  `packages/shared/src/token-usage-pricing.ts`

Inference is marked as such in §3.2. This note is not legal advice.
