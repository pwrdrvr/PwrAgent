---
title: Codex Pro, Ultra, and Responses pro mode
type: design
status: research
date: 2026-11-14
scope: desktop
sources_retrieved: 2026-11-14
base: 4bec68688108c4de3266363ec3ac71a28a143c41
independent_of: docs/design/openai-decisions-registered-prompts.md
---

# Codex Pro, Ultra, and Responses pro mode

This note answers one question: can the Codex App Server that PwrAgnt
runs expose the Pro control that people see in Chat, and what is that
control relative to Codex Ultra?

It is independent of the registered OpenAI Decisions design. It does not
change that contract, and it is not an implementation task for the
Decisions build.

No live model call, Pro stress test, token replay, or account bypass was
performed. Schema evidence is the JSON Schema emitted offline by the
installed managed binary, plus the TypeScript package this repo compiles
against.

## Four names that are not the same entitlement

| Name | What official docs say it is | What it is not |
| --- | --- | --- |
| ChatGPT Pro subscription | A paid ChatGPT plan. Pricing lists plans at $100, $200, or $500 per month. Ultrafast mode access is called out on Pro $500. | Not a model id, not a reasoning mode, not Ultra, and not a skill. |
| Chat model Pro setting | A control people describe in Chat. The fetched Codex, App Server, and Responses pages do not document that control, its internal implementation, or a way for App Server to select it. | Not proven to be `reasoning.mode=pro`, Ultra, or a prompt skill. |
| Responses API `reasoning.mode=pro` | An execution mode on `POST /v1/responses` for GPT-5.6 and GPT-6. `standard` is the default. Mode is independent of `reasoning.effort`. | Not a Codex config key, not the ChatGPT Pro plan, and not Codex Ultra. The documented example uses an API key. |
| Codex Ultra | A Codex reasoning level. The models guide says Ultra uses subagents to handle separate parts of a task in parallel. Max gives one task more reasoning time. | Not Responses pro mode, not the ChatGPT Pro plan, and not Ultrafast. |

Official pages also use "Pro" for older model ids such as a separate Pro
model slug. The reasoning guide says existing Pro model ids keep their
current behavior and pricing. The GPT-5.6 guide says to keep the selected
GPT-5.6 model and set `reasoning.mode` to `pro`, and not to switch to a
separate Pro model slug. Those ids are a fifth, historical use of the word.

## What OpenAI publicly documents about Pro

Retrieved 2026-11-14 from
[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode)
and
[GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6).

Public statements:

- GPT-5.6 and GPT-6 support `standard` and `pro` reasoning modes in the
  Responses API. Set `reasoning.mode` to `pro` for difficult tasks that
  need more model work and can tolerate higher latency and token usage.
- Mode selects standard or pro execution. `reasoning.effort` controls how
  much reasoning the model applies within that mode. GPT-5.6 defaults to
  `medium` in both modes when effort is omitted. GPT-6.1 Sol, GPT-6 Sol,
  and GPT-6 Luna also default to `medium`.
- The documented request is `POST https://api.openai.com/v1/responses`
  with `Authorization: Bearer $OPENAI_API_KEY`, model `gpt-6.1-sol`, and
  `reasoning: { "mode": "pro", "effort": "medium" }`.
- Pro mode aggregates the model work performed to produce the final answer
  and bills those tokens at the selected model's standard token rates. It
  performs more model work than standard mode, which increases token usage
  and cost.
- GPT-5.6's own page says pro mode applies more model work and returns a
  single final answer. It says you do not need to ask the model to "use
  pro mode," "think harder," or generate several candidate answers.
- The same GPT-5.6 page lists the Responses multi-agent beta in a
  different bullet. That bullet says multi-agent is similar to ultra mode
  in Codex. The similarity is stated for the multi-agent beta, not for
  pro mode.
- The Responses reference types `reasoning.mode` as `standard` or `pro`,
  separate from `reasoning.effort`.

That is the public mechanism: an API execution mode that does more model
work, aggregates the tokens, and returns one final answer. The pages do
not say Pro is a skill. They do not say it spawns subagents. They do not
give a count of agents or samples. "More model work" is not evidence for
either of those implementations.

The API-key example is a platform billing route. It is not a statement
that a ChatGPT Pro subscription includes those calls, and it is not a
fallback PwrAgnt should offer in place of a Chat Pro allowance.

## What is undisclosed

These points stay unknown after the official pages above:

- The proprietary implementation behind a Pro control in the Chat product
  UI, if that control is distinct from `reasoning.mode=pro`.
- Whether selecting Pro in Chat sends `reasoning.mode=pro`, selects an
  older `*-pro` model id, or does something Chat does not document.
- Whether a ChatGPT account signed into Codex App Server is entitled to
  that Chat control. Workspace model availability says a model setting in
  a ChatGPT workspace does not automatically apply to Codex in the desktop
  app, Codex CLI, the IDE extension, Codex cloud, or the OpenAI API, and
  that a ChatGPT model-picker setting should not be assumed to have the
  same effect on those surfaces.
- Account-specific access, rate limits, and observed cost for
  `reasoning.mode=pro`. No request was sent.

## What Ultra is, publicly

Retrieved 2026-11-14 from
[Models](https://learn.chatgpt.com/docs/models),
[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
and the
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

- Ultra mode goes beyond a single-agent run. It uses subagents to
  accelerate complex work and to handle separate parts of a complex task
  in parallel.
- Max gives the selected model more time to reason about a single task.
  Ultra and Max are different. GPT-6 Luna supports reasoning efforts up
  to Max, and does not support Ultra.
- In the CLI, `/model`, then More reasoning, shows the Max or Ultra
  options that model supports. A desktop slider can hide Ultra until
  Settings, Configuration, Ultra in model picker slider is on.
- `model_reasoning_effort` is a string. Documented examples include
  `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`. Available levels
  depend on the model and client. The subagents page also lists `ultra`
  as the deepest reasoning effort when the selected model supports it.
- The configuration reference does not list a `model_reasoning_mode` or
  `reasoning.mode` key.

Ultrafast is a third, unrelated knob. The speed guide describes it as a
faster service tier for GPT-6 Astra and GPT-6.1 Sol, available in Codex
and ChatGPT Work on Pro $500 and eligible Enterprise and Edu plans.
Included limits and credits are multiples of Standard. It is not Ultra
reasoning and not Responses pro mode. Fast mode (`service_tier`) is the
same family of speed controls, not Pro.

## App Server exposure on the Codex PwrAgnt actually runs

### Version

The managed install recorded in `~/.pwragent/agents/codex/managed-release.json`
on 2026-11-14:

| Field | Value |
| --- | --- |
| Command | `codex-cli 0.163.0-pwragent.1` |
| Tag | `pwragent-v0.163.0-pwragent.1` |
| Binary | `~/.pwragent/agents/codex/versions/pwragent-v0.163.0-pwragent.1/codex` |
| Source repository | `https://github.com/pwrdrvr/codex` |
| Source commit | `4b08d17acb6a44b7cee9da3f0ce367d1d1fd9090` |
| Asset | `pwragent-codex-0.163.0-pwragent.1-macos-aarch64.tar.gz` |

An older managed build, `pwragent-v0.162.1-pwragent.1`, is still on disk.
The release file's `latestTag` is `0.163.0-pwragent.1`. This note inspects
that binary.

PwrAgnt compiles against `@pwrdrvr/codex-app-server-protocol` **0.164.0**
(`apps/desktop/package.json`, `packages/owner-core/package.json`,
`packages/agent-tools/package.json`). That package is newer than the
binary above. Both were checked. Neither exposes Responses pro mode.

An older local Codex checkout with no hits for `reasoningMode`,
`reasoning_mode`, or `pro_mode` is not evidence about this binary. The
evidence below is the schema this binary generated:

```bash
codex app-server generate-json-schema --out ./schemas
```

`CODEX_HOME` was an empty temporary directory. The same binary was also
asked for both TypeScript surfaces. `generate-ts --help` documents
`--experimental` as "Include experimental methods and fields in the
generated output."

```bash
codex app-server generate-ts --out ./bindings
codex app-server generate-ts --experimental --out ./bindings-experimental
```

The stable command wrote 760 `.ts` files. The experimental command wrote
909. Neither logged in or started a turn. Homebrew `codex-cli 0.160.0`
is also on `PATH` and was not the binary inspected.

PwrAgnt uses the experimental surface. `initialize` in
`packages/owner-core/src/codex-app-server/client.ts` sends
`capabilities.experimentalApi: true`.

### Stable protocol fields on 0.163.0-pwragent.1

From `generate-ts` without `--experimental`:

- `ReasoningEffort` is an open `string`.
- `TurnStartParams.effort` is an optional `ReasoningEffort`. The same
  params also carry `model`, `summary`, `serviceTier`, and
  `serviceTierForTurn`.
- `ThreadSettings.effort` is `ReasoningEffort | null`. The echoed settings
  also include `model`, `serviceTier`, `summary`, and `collaborationMode`.
  Collaboration mode is the plan-versus-default preset, not pro mode.
- `ConfigurationReasoning` is `{ effort: ReasoningEffort }` only.
- `ThreadStartParams` has `serviceTier` and does not have `effort`.
- This generation has no `ThreadSettingsUpdateParams` type.

There is no `reasoningMode`, `reasoning_mode`, `reasoning.mode`, or
`pro_mode` field on a turn, thread, model, or config type. A search of
the generated TypeScript for `ultra` does not find an effort value or a
multi-agent comment. The only nearby phrase is a requirements comment
about Fast and Ultra Fast, which is the speed tier.

`model/list` params are `cursor`, `limit`, and `includeHidden`. There is
no provider argument. Each `Model` includes
`supportedReasoningEfforts`, `defaultReasoningEffort`,
`serviceTiers` (`id`, `name`, `description`), `multiAgentVersion`
(`disabled`, `v1`, or `v2`), and `availableAccessPrograms`. Whether an
account offers Ultra, or any other effort, is whatever that list returns.
The schema does not promise either. `modelProvider/capabilities/read`
returns only `{ imageGeneration, webSearch }`.

Effective config from `generate-json-schema` includes
`model_reasoning_effort`, `model_reasoning_summary`, and `service_tier`.
It does not include a reasoning-mode key.

The string `pro` appears as a `PlanType` on the account object, beside
`free`, `go`, `plus`, `prolite`, `promax`, `edu_pro`, and the other plan
ids. That is the ChatGPT subscription label returned with the account. It
is not a request field that selects pro execution.

`account/login/start` distinguishes `type: "apiKey"` from `type: "chatgpt"`.
A third variant, `chatgptAuthTokens`, is marked unstable and for OpenAI
internal use. The Sign in with ChatGPT app-server page says `model/list`
can return a bundled catalog and must be treated as a catalog, not an
entitlement check. A completed turn is what verifies access to the
selected model. This research did not start a turn.

Stable `generate-ts` still emits a `MultiAgentMode` type
(`explicitRequestOnly`, `proactive`, or `{ custom: string }`). On that
surface the type is exported and no request or response field uses it.
Stable `generate-json-schema` matches that: the type is defined, and
nothing references it.

### Experimental surface on the same 0.163.0 binary

`generate-ts --experimental` emits the Ultra comments. Package 0.164.0
repeats the same comments. On this surface:

- `TurnStartParams.multiAgentMode` is optional and marked deprecated:
  "Ignored. Use `effort: "ultra"` for proactive multi-agent behavior."
  `TurnStartParams.effort` remains the reasoning-effort override.
- `ThreadSettings.multiAgentMode` is marked deprecated: "Always
  `explicitRequestOnly`. Use `effort` for Ultra behavior."
- `ThreadSettingsUpdateParams` exists and carries optional `effort` and
  optional deprecated `multiAgentMode`, with the same "use `effort:
  "ultra"`" comment.
- `ThreadStartParams` carries optional deprecated `multiAgentMode`, with
  "Use Ultra reasoning effort for proactive multi-agent behavior." It
  still has no `effort` field. The word "effort" in that file is only in
  the comment.
- `TurnSettingsUpdateParams.effort` also exists.

A search of all 909 files finds no `reasoningMode`, `reasoning_mode`,
`reasoning.mode`, or `pro_mode`. The deprecated switch tells the client
to send the effort string `ultra` instead. It does not define Pro, and it
does not say how many agents that effort starts. Official Codex docs
remain the source for Ultra meaning subagents. This comment is the
protocol's own mapping from the old multi-agent switch onto that effort
string.

`@pwrdrvr/codex-app-server-protocol@0.164.0`, the package this repo
compiles against, repeats those same deprecated comments and still has
no `reasoning.mode` field. It is one release newer than the installed
binary. The comments are in both 0.163's experimental surface and that
package.

The first named-provider note cited the comments without saying
`--experimental`. Plain `generate-ts` does not contain them. The
correction, with `--experimental`, matches this regeneration, except
that `ThreadStartParams` has the Ultra comment on `multiAgentMode` and
does not grow an `effort` field.

### PwrAgnt passthrough today

`normalizeCodexReasoningEffort` in
`packages/owner-core/src/codex-app-server/client.ts` forwards only
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`
as `turn/start` `effort`. Any other string, including `pro`, is dropped.
`normalizeCodexServiceTier` forwards `fast` (mapped to `priority`),
`priority`, `flex`, and `ultrafast` as `serviceTier`. There is no code
path that sets `reasoning.mode`.

So this tree can already ask the managed App Server for Codex effort
`ultra` and for the Ultrafast speed tier, when the caller supplies those
strings. It cannot ask App Server for Responses pro mode or for a
Chat-only Pro setting. Whether a signed-in `model/list` currently
advertises `ultra` for a given model was not queried, because that read
would use the signed-in account.

## Verdict

| Question | Result | Proof |
| --- | --- | --- |
| Does this App Server expose Responses `reasoning.mode=pro`? | Absent | No field on the stable or `--experimental` `generate-ts` output of 0.163.0-pwragent.1, and none in protocol package 0.164.0. |
| Does it expose the Chat Pro control? | Absent on the public protocol. Unknown as a private Chat behavior. | Same schema. Official pages do not document a Chat-only Pro field or say that a Chat picker setting applies to App Server. |
| Is a later Codex version able to expose it? | Unknown | This binary and the 0.164.0 package do not. A newer unpublished protocol was not claimed. |
| Can an API-key Responses call stand in for Chat Pro? | No | Different auth and billing route. Do not add that fallback. |
| Is Pro a skill that uses subagents? | Not according to the public API docs | Pro mode is extra aggregated model work and one final answer. Subagents are documented for Codex Ultra and, separately, for the Responses multi-agent beta. |
| Is Pro different from Ultra? | Yes | Ultra is the Codex subagent reasoning level. Pro mode is a Responses execution mode. The ChatGPT Pro plan is a subscription. Ultrafast is a speed tier. |

Realistic PwrAgnt feasibility on the current managed Codex: do not add a
Pro toggle that pretends App Server can select Chat Pro. The supported
public knobs are the effort string, including `ultra` when the model
advertises it, and `serviceTier` values such as `fast` and `ultrafast`.
Exposing Responses `reasoning.mode=pro` requires a protocol field this
Codex version does not have. Inventing a config passthrough, replaying a
Chat token against a private route, or sending an API-key request and
labeling it Pro would not be that feature.

Named OpenAI-compatible providers should keep Pro out of the provider
picker. A custom Responses base URL does not gain Chat Pro entitlement,
and `reasoning.mode` is not a catalog row this App Server lists.

## Sources

- https://developers.openai.com/api/docs/guides/reasoning — retrieved 2026-11-14
- https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6 — retrieved 2026-11-14
- https://developers.openai.com/api/docs/guides/latest-model — retrieved 2026-11-14
- https://developers.openai.com/api/reference/resources/responses — `reasoning.mode` is `standard` or `pro`
- https://learn.chatgpt.com/docs/models — retrieved 2026-11-14
- https://learn.chatgpt.com/docs/agent-configuration/subagents — retrieved 2026-11-14
- https://learn.chatgpt.com/docs/config-file/config-reference — `model_reasoning_effort`, retrieved 2026-11-14
- https://learn.chatgpt.com/docs/agent-configuration/speed — Fast and Ultrafast, retrieved 2026-11-14
- https://learn.chatgpt.com/docs/pricing — ChatGPT Pro plan, retrieved 2026-11-14
- https://learn.chatgpt.com/docs/enterprise/workspace-model-availability — retrieved 2026-11-14
- https://learn.chatgpt.com/docs/app-server — public `model/list` and `turn/start` fields, retrieved 2026-11-14
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server — catalog versus entitlement, retrieved 2026-11-14
