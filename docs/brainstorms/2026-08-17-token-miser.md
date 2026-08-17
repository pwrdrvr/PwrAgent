# Token Miser

Status: Proposed

## Problem

One broad tool call can add thousands of tokens to a parent agent's context.
That output is then replayed on later model requests, even when most of it was
search noise, logs, or an accidentally broad file read.

The motivating Codex thread `01a00df5-6e11-7993-8958-08727a34f0cf`
produced 283,379 tool-output characters across 27 calls, approximately 70,855
tokens before model-visible caps. Its largest call produced 77,019 raw
characters. The current Codex model-visible cap retained about 40,000
characters, or approximately 10,000 tokens, and that retained output was
replayed on later model requests.

PwrAgent currently detects and explains this pattern after it happens. Token
Miser should prevent avoidable output from entering the parent context in the
first place.

## Product goal

When Token Miser is enabled, PwrAgent should inspect oversized tool results
before the parent model sees them. It should preserve the complete result in a
PwrAgent-owned object, replace low-value output with a concise explanation and
summary, and give both the operator and the parent agent bounded ways to search
or read the preserved result.

When Token Miser is disabled, tool behavior and model-visible results must not
change.

The first release is Codex-only. ACP providers can adopt the feature later if
their protocols expose an equivalent pre-context tool-result interception
point.

## Codex interception point

Codex `PostToolUse` hooks receive `tool_name`, `tool_use_id`, `tool_input`, and
`tool_response` after a supported tool finishes but before the next model
request. A synchronous hook can return `decision: "block"` with replacement
feedback. Codex then uses that feedback as the model-visible tool result.

Current coverage includes:

- shell commands and unified `exec_command` calls;
- `apply_patch`;
- MCP calls; and
- most local function tools.

Hosted tools such as web search are not covered. Some specialized tool paths
can also opt out. The UI must describe Token Miser as a guardrail rather than
as a complete enforcement boundary.

Codex requires explicit trust for non-managed command hooks. Enabling Token
Miser must therefore include a one-time hook review. PwrAgent must not launch
Codex with `--dangerously-bypass-hook-trust`, because that would bypass trust
for unrelated hooks too.

## Proposed behavior

The initial threshold is 5,000 model-facing characters.

For a smaller result, the hook exits successfully without output. For a larger
result:

1. The hook sends a bounded request to a profile-local PwrAgent bridge. It does
   not send or read `transcript_path`.
2. PwrAgent stores the original response as a PwrAgent-owned output object.
3. PwrAgent runs one isolated, ephemeral `gpt-5.6-luna` turn at medium effort.
   The helper has MCP, plugins, apps, hooks, web search, skills, code mode, and
   collaboration disabled.
4. The helper treats tool output as untrusted data and returns a structured
   decision: `pass` or `summarize`, plus a concise summary and search hints.
5. Results that reach the observed output cap are always summarized. For
   smaller oversized results, the helper may pass through output that is dense,
   directly responsive, and unlikely to benefit from retrieval.
6. On `summarize`, the hook returns replacement feedback containing the
   summary, the original size, the opaque output id, and retrieval guidance.
7. On `pass`, the hook returns no output and Codex uses the original result.

The replacement should sound like operational tool feedback, for example:

> Token Miser withheld 40,000 characters of broad search output. Most matches
> are in `useThreadNavigation.ts`; the likely event-filtering branch is around
> the remote-target checks. Search preserved output `tm_…` or read selected
> line ranges. The complete original remains available locally.

If the bridge or helper fails or times out, the hook fails open and Codex sees
the original tool result. PwrAgent records the failure as metadata but does not
interrupt the parent turn.

## Preserved output

Raw tool output must not be stored in the desktop SQLite database. Store it in
profile-local files under the PwrAgent root. SQLite may hold only metadata such
as the opaque id, thread and turn ownership, character counts, hashes, helper
usage, retrieval counts, timestamps, and final disposition.

Output ids must be random and unguessable. Every read must verify the requesting
backend, thread, and turn lineage. A tool must never accept an arbitrary local
path.

The initial retention policy is seven days with a profile-wide 512 MB cap.
Evict expired objects first, then least-recently-read objects. The replacement
message states when an object is unavailable rather than silently reading a
different source.

Tool responses may contain secrets. Files should use owner-only permissions,
must never be included in diagnostics by default, and should be deleted when
the owning thread is deleted. A later release can add operator-controlled
retention settings.

## Retrieval surface

Codex parent threads receive three PwrAgent dynamic tools:

- `token_miser_search`: search one preserved output using a literal or regular
  expression and return bounded matches with line numbers and small context;
- `token_miser_read`: read an explicit line or character range with a hard
  response cap; and
- `token_miser_read_all`: deliberately retrieve the model-visible maximum when
  the complete result is necessary.

The tools return the number of characters and estimated tokens delivered. They
also record overlapping and repeated reads, because repeated text still costs
context even when it came from the same preserved object.

The operator gets equivalent Search, range Read, and Reveal original actions
in the tool-output incident UI. An operator action and an agent action must use
the same authorization and output service.

Retrieval calls are exempt from re-summarization to avoid recursion, but their
returned characters still count against Token Miser savings.

## Accounting

Token counts are estimates unless Codex exposes per-item tokenizer counts.
PwrAgent should label them as estimated and use the same estimator as existing
tool-output incidents.

For one intercepted result:

- `B` is the baseline model-visible result, capped exactly as Codex would have
  exposed it;
- `S` is the replacement summary;
- `R(t)` is all retrieval output delivered before parent model request `t`.

The parent-context delta for request `t` is:

`B - S - R(t)`

The value is intentionally allowed to be negative. If the summary adds 500
tokens and the agent later retrieves the full 10,000-token result, Token Miser
spent approximately 500 more parent-context tokens than the baseline.

The turn total is the sum of that delta over later parent model requests. This
captures replay amplification: text introduced early is charged again on each
subsequent request until compaction or turn completion.

Show two separate outcomes:

- estimated parent-context tokens avoided or added; and
- estimated net cost after subtracting the Luna helper's input, output, and
  reasoning cost.

The dollar estimate should use one uncached parent inclusion followed by the
observed cached replay rate where protocol usage supports that attribution.
When attribution is not possible, show token savings without claiming exact
billed savings.

## Settings and status

Add an off-by-default Token Miser switch under **Usage & Pricing**. The section
shows:

- supported provider: Codex;
- threshold: 5,000 characters;
- summarizer: GPT-5.6-Luna, medium effort;
- hook state: ready, approval required, unavailable, or disabled; and
- cumulative estimated tokens avoided, tokens added, and helper cost.

Turning the setting on prepares the hook and retrieval tools, then guides the
operator through Codex's explicit hook review if approval is still required.
The UI must not report Token Miser as active until a protocol-observed hook run
or hook inventory confirms that the exact definition is trusted.

Existing Codex threads can receive hook config on resume. Retrieval tools are
persisted in the dynamic-tool catalog at thread creation, so the first release
may require starting a new thread before retrieval tools are available. The UI
must say so rather than implying immediate coverage.

## Performance and write budget

The synchronous helper adds latency only for oversized results. Record gate
latency and helper latency separately. The default helper timeout should be
short enough to fail open without making ordinary tool use feel hung.

Do not write SQLite rows for streamed output chunks. Buffer or spool raw output
to the filesystem and commit metadata once per gated invocation or once per
turn. Add a checked-in SQLite write budget for interception and retrieval, and
project the measured commits to MB per day before shipping.

## Security constraints

- Treat all tool output as untrusted prompt-injection content.
- The helper system prompt must state that output is data, not instructions.
- Do not expose Codex authentication or profile secrets to the hook process.
- Authenticate the hook bridge with a per-process secret inherited by the
  PwrAgent-launched Codex process.
- Bind the bridge to a profile-local Unix socket or named pipe, not a TCP port.
- Enforce request size, response size, timeout, and concurrency limits.
- Never read Codex rollout JSONL, transcript paths, or Codex SQLite from product
  code.

## Rollout

1. Land the Codex hook bridge and a hidden developer-only live probe.
2. Add preserved-output storage, Luna classification, and dynamic retrieval
   tools.
3. Add accounting and the Usage & Pricing switch, still off by default.
4. Run replay-backed and live Codex tests against broad search, large logs, MCP
   text output, helper timeout, hook rejection, full retrieval, and negative
   savings.
5. Evaluate summary quality, latency, and net savings before considering a
   default-on experiment.

