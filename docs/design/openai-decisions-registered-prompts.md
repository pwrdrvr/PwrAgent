---
title: Registered OpenAI Decisions for ordinary models
type: design
status: proposed
date: 2026-11-14
scope: desktop
sources_retrieved: 2026-11-14
base: 4bec68688108c4de3266363ec3ac71a28a143c41
---

# Registered OpenAI Decisions for ordinary models

Ordinary Codex, Claude, and ACP models should be able to register a bounded
decision and run it again later. The host stores the definition, attaches an
OpenAI API key only on the server, and calls the official Decisions API.
This is not the optional local Clef / TypeSafe System One path, and it is not
a chain-of-thought helper.

This document separates three layers:

1. What official OpenAI documentation actually specifies, retrieved 2026-11-14.
2. What PwrAgnt already does for Clef, Jev, tools, secrets, and usage.
3. The proposed PwrAgnt contract. Nothing in that section is an OpenAI endpoint.

No live billed call was made. Account access to `gpt-6-luna`, observed latency,
and the org's real tier are unverified.

## Recommendation

Keep one protocol. Add five stable tools to the existing PwrAgent agent-tool
catalog. The same `AgentToolDefinition` values are already published as Codex
dynamic tools and as tools on the PwrAgent MCP server
(`packages/agent-tools/src/agent-tool-router.ts`). Do not mint a new tool per
registered decision, and do not add a second MCP server or a gateway
`call_mcp_tool` connection.

OpenAI has no registration, version, update, or delete API for a decision.
`POST /v1/decisions` evaluates questions sent on that request. PwrAgnt stores
the questions and an optional stable input prefix, then replays them.
Prompt caching can reuse an identical input prefix. It does not store the
question list, and question text is outside the cached prefix.

The model id on every call is `gpt-6-luna`. Callers do not choose a model.
The key is a profile secret, never a tool argument, and never a Codex or
ChatGPT Pro OAuth token.

## Official API, retrieved 2026-11-14

Primary pages:

- Guide: <https://developers.openai.com/api/docs/guides/decisions> (markdown
  retrieved 2026-11-14; search listed it as published 2026-11-14 03:16 UTC).
  The guide says the Decisions API is generally available.
- Create reference:
  <https://developers.openai.com/api/reference/resources/decisions/methods/create>
  (markdown retrieved 2026-11-14).
- Resource index:
  <https://developers.openai.com/api/reference/resources/decisions>
  (search listed it as published 2026-11-14 04:03 UTC). The index documents
  one method, `POST /decisions`.
- Model: <https://developers.openai.com/api/docs/models/gpt-6-luna>
  (markdown retrieved 2026-11-14).
- Rate limits: <https://developers.openai.com/api/docs/guides/rate-limits>
  (markdown retrieved 2026-11-14; search listed it as published 2026-11-14 03:15 UTC).
- Voice delegation, for contrast only:
  <https://developers.openai.com/api/docs/guides/decisions-voice>
  (search listed it as published 2026-11-14 03:16 UTC).
- Org usage:
  <https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/decisions>.
- Auth headers:
  <https://developers.openai.com/api/reference/overview>.
- Prompt caching concepts:
  <https://developers.openai.com/api/docs/guides/prompt-caching>.
  Decisions-specific cache rules below come from the Decisions guide and the
  create reference, which are narrower than the Responses guide.

### The only decision endpoint

```http
POST https://api.openai.com/v1/decisions
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

Optional headers, from the API overview, when a legacy user key belongs to
more than one organization or project:

```http
OpenAI-Organization: $ORGANIZATION_ID
OpenAI-Project: $PROJECT_ID
```

Usage from those requests counts for that organization and project. The
overview says most API-key permission changes propagate within 15 minutes and
can take longer. It recommends keeping total request headers under 64 KiB and
logging `x-request-id`. Response headers can include `openai-organization`,
`openai-processing-ms`, `openai-version` (documented as REST version
`2020-10-01`), and the `x-ratelimit-*` fields in the rate-limits guide.
`Retry-After` can appear on temporary `429` and `503` responses.

The create reference's body fields are `input`, `model`, `questions`, and
optional `prompt_cache_key`, `prompt_cache_options`, and `safety_identifier`.
There is no `reasoning`, `service_tier`, `temperature`, `tools`, `store`,
`background`, or region field on this body.

`model` is a string. The guide and the create reference both say only
`gpt-6-luna` is supported.

### Question types

`questions` has 1 to 400 items. Answers come back in the same order. Any
question can be a refusal while the others still receive answers. A refusal
is `{ "type": "refusal", "name": "<name or null>" }`. It is not an HTTP error.

| Type | Required shape | Answer |
| --- | --- | --- |
| `predicate` | `instructions`, `type: "predicate"`, optional `name` | `probability` number |
| `choice` | `choices` (2–255 unique), `instructions`, `type: "choice"`, optional `name` | `choice` (string or boolean), `probabilities`, `confidence` |
| `score` | `levels` (2–10 ordered `{label, description?}`), `instructions`, `type: "score"`, optional `name` | `score` (probability-weighted level index, can fall between levels), `probabilities` (`value` is the 0-based index), `confidence` |

Choice `value` is a string or a boolean. A string and a boolean with the same
text are distinct. The guide says both `value` and `description` are part of
the prompt, so changing a value can change the result. It recommends
meaningful labels and a fallback such as `"other"`.

`instructions` is a string (max length 1,048,576) or a non-empty array of up
to 16,384 parts: `input_text`, `input_image`, or `input_json`. Question images
share the request's image limits with images in `input`. The create reference
does not state a separate numeric image count. `name` max length is 1,048,576.
PwrAgnt will impose much smaller product bounds; those bounds are not OpenAI
limits.

`input_json` inside instructions or user content is data. Keys such as `role`
inside `data` do not create messages. Limits: 32 container levels, 10,000
values, and 256 KiB of compact UTF-8 JSON.

### Input

`input` is a string (max length 10,485,760) or an array of up to 131,072
items:

- User message: text, images, and JSON.
- Developer or system message: input text only. System messages are treated
  as developer messages.
- Assistant message: output text or refusals, optional phase `commentary` or
  `final_answer`.
- `function_call` / `function_call_output` and `custom_tool_call` /
  `custom_tool_call_output`. Each output must match a call by `call_id`.

Images are base64 data URLs or public `http`/`https` URLs
(`pattern: ^(data:|https?://)`, max length 1,073,741,824). `file_id` is not
supported. `detail` is `low`, `high`, `auto` (default), or `original`.
Files, audio, and item references are not supported. Tool calls are evidence
only. Decisions returns typed answers; the application runs any action.

### What is not in the API

The fetched resource index lists create and the decision models. It does not
list list, get, update, delete, or a stored prompt, config, or decision id.
There is no OpenAI version field. A repeated decision is a new `POST` with
the same questions and a new `input`.

"Reusable prompt" in the official text means a prompt-cache prefix, not a
registered object. The create reference describes
`prompt_cache_breakpoint` as marking "the exact end of a reusable prompt
prefix." The Decisions guide says:

- By default, Decisions places an implicit cache breakpoint at the end of
  shared `input`.
- The reusable prefix must contain at least 1,024 tokens. Question content,
  including question images, does not count and is outside the prefix.
- Breakpoints are not supported in question instructions.
- `prompt_cache_key` (max length 64) partitions reuse by a caller-provided key.
- `prompt_cache_options.mode` is `implicit` (default) or `explicit`. Implicit
  writes one implicit breakpoint and up to the latest three explicit
  breakpoints. Explicit writes up to four and does not cache when none are
  marked.
- `prompt_cache_options.ttl` defaults to `30m`, and the create reference says
  that is currently the only supported value on this endpoint. The backend
  may retain entries longer. The prompt-caching guide's 12-hour TTL is
  described for the Responses API. Do not send `12h` on `/v1/decisions`.
- `usage.input_tokens` already includes `cached_tokens` and
  `cache_write_tokens`. Do not add those counts to `input_tokens`.

`safety_identifier` is an opaque end-user id, max length 128, scoped by the
verified org. It is not the authenticated user.

The guide's TypeScript example uses `client.decisions.create` from the
`openai` package. This repository has no `openai` dependency (no `openai`
package in workspace `package.json` files on this base). Do not invent an SDK
method. Call the documented HTTP body until a pinned SDK is shown to expose
`decisions.create`. The Go example in the same guide uses
`github.com/openai/openai-go/v3` `client.Decisions.New`. No SDK commit was
vendored here.

### Model, price, and limits

From the `gpt-6-luna` model page, for the model in general:

| Item | Documented value |
| --- | --- |
| Model id | `gpt-6-luna` (also the only listed snapshot) |
| Context window | 1,050,000 |
| Maximum input tokens | 922,000 |
| Maximum output tokens | 128,000 |
| Knowledge cutoff | May 18, 2026 |
| Input modalities | text, image |
| Output modalities | text |
| Audio and video | not supported |
| Uncached input | $0.10 / 1M tokens |
| Cached input | $0.01 / 1M tokens (10% of uncached) |
| Cache writes | $0.125 / 1M tokens (1.25× uncached) |
| Output | $0.50 / 1M tokens |
| Long context | more than 272K input tokens: 2× input and cache rates and 1.5× output for the full request |
| Regional processing | 10% premium where available |
| Batch and Flex | 50% of Standard |
| Fast | 2× applicable rates |
| `reasoning.effort` | `none`, `low`, `medium` (default), `high`, `xhigh`, `max` |

The Decisions guide overrides the output price for this endpoint: with
`gpt-6-luna`, uncached input is **$0.10 per 1M tokens**, cache reads and
cache writes use the standard `gpt-6-luna` cache rates, and **output tokens
are not charged**. It also says regional premiums and long-context input
multipliers apply to `/v1/decisions`, and that other requests using
`gpt-6-luna` follow the model page. The 272K threshold is stated on the model
page, not restated as a separate number in the Decisions guide.

The create body has no field for Batch, Flex, Fast, service tier, or region.
Do not apply the 50% or 2× multipliers, and do not add the 10% regional
premium, unless a later official field is used. Unknown regional application
is not $0 and is not 10%: the local estimate labels standard processing and
records the premium as not selected.

Standard rate limits from the model page and the rate-limits guide (Luna row):

| Tier | RPM | TPM | Batch queue (model page) |
| --- | ---: | ---: | ---: |
| Free | not supported on the model page | | |
| Build ($5 purchased) | 5,000 | 2,000,000 | 20,000,000 |
| Launch ($100) | 10,000 | 10,000,000 | 1,000,000,000 |
| Grow ($500) | 30,000 | 180,000,000 | 15,000,000,000 |

The rate-limits guide also lists monthly usage limits (Free $100, Build $500,
Launch $5,000, Grow $200,000) and says a model's rate-limit entry does not
confirm access. A missing model or `model_not_found` is an access check, not
proof of a bug. Limits are organization and project scoped, not per user.
Some families share a limit; whether Decisions shares Luna's Responses TPM
is not stated. There is no Decisions-specific concurrency cap in the fetched
pages.

Platform error guidance, not a Decisions error catalog (the create page shows
a 200 example and no error schema):

| HTTP | `error.type` | `error.code` | Action |
| --- | --- | --- | --- |
| 429 | `rate_limit_error` | `slow_down` | Honor `Retry-After` when valid, reduce rate, ramp gradually. Can happen inside RPM/TPM. |
| 503 | `service_unavailable_error` | `server_is_overloaded` | Honor `Retry-After`, then retry. |

The rate-limits guide says official SDKs retry eligible 429 and 503 responses,
that handling of long `Retry-After` values varies by SDK version, and that
unsuccessful requests count toward the per-minute limit. Do not retry quota,
billing, or other errors that need a person. A hard spend limit returns 429.
The guide's rule of thumb is to increase traffic by no more than 50% every
15 minutes once traffic reaches 1M input TPM. That example retries the
Responses API, not `/v1/decisions`.

`GET /v1/organization/usage/decisions` needs an admin key and
`api.usage.read`. It groups by `project_id`, `user_id`, `api_key_id`,
`model`, `batch`, `service_tier`, and `api_source`. `num_model_requests`
counts requests, not questions. This is an operator reconciliation API. The
agent path must not call it and must not hold an admin key.

The voice guide says native GPT-Live delegation needs a working Live
connection and `api.decisions.write`, and does not need a Decisions-specific
alpha header. That sentence is about Live (`gpt-live-1` calling Decisions).
The create reference authenticates `POST /decisions` with
`Authorization: Bearer $OPENAI_API_KEY` and does not name a scope. Whether a
restricted project key must include the scope string `api.decisions.write`
for ordinary POST calls is unverified. Admin key-update docs say scopes
replace the key's restrictions, an empty array means all permissions subject
to the owner, and `api.all.read` is read-only. An admin key is a different
credential from a project workload key.

The Decisions guide says the API supports Zero Data Retention and HIPAA for
eligible customers, data residency in all supported API regions, and regional
processing in the United States and Europe (EEA + Switzerland), subject to
<https://developers.openai.com/api/docs/guides/your-data>. Eligibility is an
account agreement, not something this design can turn on. Private Link is
listed as a capability and is out of scope.

The model page's endpoint table does not list `v1/decisions`. It lists Chat
Completions, Responses, and Batch as supported, and Live as not supported.
The Decisions guide, retrieved the same day, says `POST /v1/decisions` uses
`gpt-6-luna` and that Live calls Decisions through a separate voice
integration. Trust the Decisions guide for this endpoint. Do not send
Decisions traffic to `/v1/responses`, `/v1/chat/completions`, or
`/v1/live/sessions`.

The create response `usage` object includes `output_tokens` and
`output_tokens_details.reasoning_tokens`. The guide's examples show both at 0,
and the guide says output tokens are not charged. `reasoning.effort` is not a
field of `POST /decisions`. Do not send it. Record `reasoning_tokens` when
present. Do not add them to `output_tokens`, and do not price them a second
time. The product usage ledger already treats reasoning tokens as a subset of
output (`docs/usage-activity.md`).

Cache pricing for a Decisions request, using only documented rates:

```text
uncached = input_tokens - cached_tokens - cache_write_tokens
price = uncached * $0.10/1M
      + cached_tokens * $0.01/1M
      + cache_write_tokens * $0.125/1M
      + output_tokens * $0
```

If `input_tokens` is greater than 272,000, the model page's long-context rule
is 2× input and cache rates for the full request. Apply that only when the
line is one measured Decisions request (`inputTokenScope: "request"`). The
existing pricer refuses to put an aggregate over the long-context band
(`packages/shared/src/token-usage-pricing.ts`). If the subtraction is
negative, the usage object is inconsistent: store the raw counts and set the
price status to unavailable. Do not clamp to zero and call it free.

Codex or ChatGPT Pro subscription estimates are a different account. These
HTTP calls are API project usage. An unknown price is not zero.

### Access gaps

- No live `GET /v1/models` or Decisions call was made. Org, project, and key
  access to `gpt-6-luna` is unverified. Free tier is "Not supported" on the
  model page.
- No Decisions-specific error list, image-count cap, or concurrency cap was
  on the fetched create page.
- No request field selects region, service tier, Batch, Flex, or Fast.
- `api.decisions.write` is documented for Live native delegation, not proven
  as the POST scope.
- The model catalog endpoint table omits `v1/decisions`.
- Cache hits are not guaranteed. Below 1,024 prefix tokens there is no
  reusable prefix. Questions never count toward it.
- No latency number is published beyond "about 10x faster than the Responses
  API." Clef timings in `docs/native-live-voice.md` are a different server
  and must not be copied.
- SDK package version that first shipped `client.decisions.create` was not
  pinned from a local checkout.

## What PwrAgnt does today

Checked on `4bec68688108c4de3266363ec3ac71a28a143c41` (`origin/main` at
2026-11-14 10:36 -0500, `chore(release): prepare v1.4.3`).

### Clef and Jev stay on System One

`packages/shared/src/decision-models.ts` knows two providers, `local` and
`jev`, plus `off`. Both speak TypeSafe System One:
`POST <base>/v1/systemone`. Local defaults to `http://127.0.0.1:8787` and
`clef-flash`. Jev defaults to `https://api.typesafe.ai` and `jev-latest`.
Camera cues require the local model so frames stay on this Mac.
`apps/desktop/src/main/decision/system-one.ts` posts `{ model, state,
questions, images? }` with an optional bearer header. That body is not the
OpenAI Decisions body (`input` / `questions` predicate-choice-score /
`gpt-6-luna`).

Secrets `decisionLocalApiKey` and `typesafeJevApiKey` live in
`DesktopSettingsSecretName` (`packages/shared/src/contracts/settings.ts`) and
are stored through `SettingsSecretStorage`
(`packages/owner-core/src/settings-secret-storage.ts`). Desktop encrypts with
OS `safeStorage`. Headless uses file-key encryption. Callers receive values,
not a database handle. The renderer settings snapshot reports presence, not
the key (`desktop-settings-service.ts` builds `decisionSecrets` as presence).

Do not add `"openai"` to `DecisionProviderId`. That union is the Live camera
and voice decision choice. A missing Clef server must keep failing the Clef
path. OpenAI Decisions must not become its fallback, and Clef must not become
the fallback for a failed OpenAI call.

### One tool catalog, two transports

`AgentToolDefinition` (`packages/agent-tools/src/agent-tool-definition.ts`)
has one `dispatch`. `AgentToolRouter.buildDynamicToolSpecs` publishes Codex
dynamic tools. `buildMcpTools` publishes the same definitions to the PwrAgent
MCP server unless `advertiseMcp` is false. `resolveAgentToolCatalogs`
(`apps/desktop/src/main/agent-tools/agent-tool-catalog-registry.ts`) is where
a new family joins the catalogs.

Codex dynamic tools are part of thread start. `docs/native-live-voice.md`
records that stock Codex supports dynamic tools at `thread/start` and does
not treat a later catalog edit as a new native tool. A tool created per
registered decision would be invisible to threads that have already started,
and its description would copy the prompt into the parent transcript.

`search_mcp_tools` / `call_mcp_tool` are the external MCP gateway
(`docs/mcp-gateway-tools.md`). They take a connection id and schema revision.
Decisions are host tools, not an upstream MCP server. Routing them through
the gateway would be a second protocol and would give the model a place to
pass a credential.

### Credentials and accounts

`codexModelProviderKeys` is one JSON object of API keys keyed by Codex model
provider id. Named OpenAI-compatible providers, including a full catalog
picker, are owned by Claude thread
`0db19a31-e659-470d-9ac6-ac6d18514fc6` on branch
`feat/codex-named-openai-compatible-providers` in worktree
`/Users/huntharo/.pwragent/worktrees/mwgobiap/PwrAgnt`. As of this writing
that worktree is dirty in:

- `packages/shared/src/contracts/backend.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/provider-picker.ts`
- `packages/shared/src/__tests__/provider-picker.property.test.ts`

Do not edit those files in parallel. Do not add a provider-picker row for
Decisions. Do not read or write `codexModelProviderKeys` for this feature.

`usageAccountKey` hashes a ChatGPT/Codex account id. That key is the Pro
subscription identity. `codexModelProviderAccountKey(baseUrl, apiKey)` hashes
the endpoint origin and a digest of the key. The key is not stored in the
account key. Decisions should use that function, or the same recipe if the
provider thread starts editing `packages/owner-core/src/usage-account-identity.ts`,
with base URL `https://api.openai.com`. Same origin and same key then share
an account bucket with a named OpenAI provider. The `source` column keeps
the spend lines distinct so a decision call is not also counted as a provider
chat completion.

`thread_usage_lines.provider` defaults to `'openai'`. Pricing and the ledger
treat provider `openai` as the Codex/OpenAI subscription family
(`token-usage-pricing.ts`, `thread-usage-ledger.ts`). A Decisions line that
uses provider `openai` and the parent thread's ChatGPT `account_key` would
be mixed into Pro estimates. Use a different provider value and the API
account key above. Do not copy `rate_limit_snapshot` from the Codex account.

### Persistence

Profile state is SQLite in `packages/sqlite-storage`. Schema fragments live
beside `state-schema.ts` and are applied by the existing state database
migrator. A decision registry belongs there, in the owner profile database,
not in the thread transcript and not in a repo file.

## Proposed PwrAgnt contract

This section is a product contract. These paths are not OpenAI endpoints.

### Tools

Namespace `pwragent`. Advertise on dynamic tools and on the PwrAgent MCP
server. `deferLoading` may be true so unused threads do not pay prompt tokens
for the full schema. Descriptions must not contain an example API key, a
secret name's value, or a registered prompt body. They tell the model to call
`decisions_list`.

All five tools dispatch to one service. MCP and dynamic calls share it.
Arguments are the model's data. The service loads the secret itself.

#### `decisions_register`

Registers a new active name or fails if that name is already active in the
caller's scope.

```json
{
  "name": "route_support_ticket",
  "scope": "profile",
  "instructions": "Which queue should handle this ticket?",
  "question": {
    "type": "choice",
    "name": "queue",
    "choices": [
      { "value": "billing", "description": "Payments, invoices, and refunds." },
      { "value": "other", "description": "Anything else." }
    ]
  },
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["ticket"],
    "properties": { "ticket": { "type": "string", "maxLength": 8000 } }
  },
  "prefix": "Shared rubric text reused across invokes."
}
```

Product bounds, tighter than the API, so a tool call stays small:

| Field | Bound |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,63}$` |
| `scope` | `profile` (default) or `thread` |
| questions | 1–16. The shortcut `question` above is one question. `questions` is the array form. |
| instruction string | 1–8,000 characters. Image and JSON instruction parts are rejected in v1. |
| choice values | 2–32 unique strings. Booleans are rejected in v1 so tool results stay unambiguous. |
| score levels | 2–10, labels 1–80 characters, unique |
| `inputSchema` | a JSON Schema object, at most 8 KiB, no `$ref` and no remote `$schema` fetch |
| `prefix` | optional string, at most 32,000 characters. No image. |

The service compiles this into the OpenAI `questions` array and an optional
developer message. It does not call OpenAI on register. Registration is local.

Success returns `{ decisionId, name, version: 1, scope }` and the input
schema. It does not echo the full instructions back into logs. The tool
result may echo them once so the registering model can confirm; the desktop
log and usage line must not.

#### `decisions_list`

Returns active definitions visible to this thread: profile scope in this
profile, plus thread scope owned by this backend and thread. Each entry has
`decisionId`, `name`, `version`, `scope`, question type, question name,
allowed choice values or score labels, and `inputSchema`. It omits the
prefix and the full instructions unless `includeInstructions: true` is set,
and even then omits nothing that looks like a credential. There is no key
material in the row.

#### `decisions_invoke`

```json
{ "name": "route_support_ticket", "version": 1, "input": { "ticket": "I was charged twice." } }
```

`version` is optional and pins a stored version. Omitted means the latest
active version. `input` is validated against the stored schema before any
HTTP call. A string schema expects a string. An object schema expects an
object and is sent as one user `input_json` part. v1 rejects image inputs.

The HTTP body is built only in the main process:

```json
{
  "model": "gpt-6-luna",
  "input": [
    {
      "role": "developer",
      "content": [
        {
          "type": "input_text",
          "text": "<stored prefix>",
          "prompt_cache_breakpoint": { "mode": "explicit" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "input_json", "data": { "ticket": "I was charged twice." } }
      ]
    }
  ],
  "questions": [ "<stored question>" ],
  "prompt_cache_key": "<stored key>",
  "prompt_cache_options": { "mode": "explicit", "ttl": "30m" },
  "safety_identifier": "<opaque hash, max 128>"
}
```

Omit the developer message, breakpoint, and cache options when `prefix` is
empty. Implicit caching then applies only if the remaining input is at least
1,024 tokens. Do not promise a cache hit. The cache key is the first 64
characters of a hex sha256 of `decisionId`, `version`, and the canonical
question and prefix JSON. It is not the API key and not the user input.

`safety_identifier` is
`sha256("pwragent-decisions\0" + profileId + "\0" + backend + "\0" + threadId)`
truncated to 64 hex characters. It is not an email and not an account id.

Headers:

```http
Authorization: Bearer <openaiDecisionsApiKey>
OpenAI-Project: <setting, only if the operator saved one>
OpenAI-Organization: <setting, only if the operator saved one>
```

The bearer value is read from `SettingsSecretStorage` inside the client
function that calls `fetch`. It is not placed on the registry row, the tool
definition, MCP arguments, MCP results, logs, process argv, reports, or git.
Log the decision id, version, HTTP status, `x-request-id`, and token counts.
Strip `Authorization` and any body field named like a key before logging a
failure. Truncate upstream error text to 200 characters, matching
`systemOneErrorDetail`.

Timeout: 30 seconds, abortable by the tool-call signal. No SDK retry loop
stacked on an application loop. Retry at most twice, and only when the status
is 429 with `error.code` `slow_down` or 503 with `error.code`
`server_is_overloaded`, and a valid `Retry-After` is at most 20 seconds.
Otherwise return `rate_limited` or `overloaded` with the request id. Do not
retry 400, 401, 403, 404, or billing errors. Do not fall back to Clef, Jev,
Responses, or the parent model.

A completed body with a refusal is success. Return every answer. The parent
model decides what a refusal means.

Per decision id, allow one in-flight HTTP call and a queue of four. A fifth
waiter receives `busy` without a new HTTP call. That queue is a local guard.
OpenAI does not document it.

#### `decisions_update`

Same body as register plus `name` or `decisionId`. Allowed for the owner:
profile scope for any thread in the profile, thread scope only for the
owning thread. Update inserts a new version and points the active name at
it. Old versions stay readable for pinned invoke and are not rewritten.
The new version gets a new `prompt_cache_key`. This does not call a PATCH
on OpenAI, because that method does not exist.

#### `decisions_delete`

Soft-deletes the active name. Pinned invoke of a deleted version returns
`decision_deleted` and does not call OpenAI. Names can be registered again;
the new row is a new `decisionId` starting at version 1.

### Errors

Tool failures use `agentToolFailure`. Codes:

| Code | When | HTTP? |
| --- | --- | --- |
| `decision_name_taken` | register collides with an active name in scope | no |
| `decision_not_found` | unknown name or hidden thread scope | no |
| `decision_deleted` | pinned version was deleted | no |
| `invalid_definition` | register/update failed local validation | no |
| `invalid_input` | invoke input failed the stored schema | no |
| `credential_missing` | secret absent | no |
| `credential_rejected` | HTTP 401 or 403 | yes |
| `model_unavailable` | `model_not_found` or HTTP 404 | yes |
| `rate_limited` | 429 after the retry rule | yes |
| `overloaded` | 503 after the retry rule | yes |
| `busy` | local queue full | no |
| `upstream_error` | other HTTP or network failure | maybe |

Messages name the code and, when present, `x-request-id`. They never include
the bearer token, the secret storage path, or argv.

### Registry rows

Table `openai_decision_versions` in the profile state database:

| Column | Notes |
| --- | --- |
| `decision_id` | local UUID, not an OpenAI id |
| `version` | integer, starts at 1 |
| `name` | the stable tool argument |
| `scope` | `profile` or `thread` |
| `owner_backend`, `owner_thread_id` | required for `thread`; thread id null for `profile` |
| `status` | `active` or `deleted` |
| `questions_json` | canonical OpenAI questions array |
| `prefix_text` | nullable |
| `input_schema_json` | JSON Schema |
| `prompt_cache_key` | 64 hex chars |
| `created_at` | unix ms |
| primary key | `(decision_id, version)` |

Partial unique index: one `active` row per `(name, scope, owner_backend,
owner_thread_id)`. Profile rows use an empty owner thread id in that index.
Deleted rows stay. No secret column. No raw HTTP response body.

### Credential setup

Add `openaiDecisionsApiKey` to `DesktopSettingsSecretName` and store it like
`typesafeJevApiKey`. Optional non-secret settings `openaiDecisionsOrganizationId`
and `openaiDecisionsProjectId` are trimmed ids the operator pastes from the
OpenAI dashboard. They are not keys. Validate them as short visible ids
(length 1–64, no whitespace) and do not log them next to token text.

Settings → AI Providers gets a section titled OpenAI Decisions, separate from
the existing Decisions radio (Off / local Clef / Jev) and separate from the
named-provider picker. The section explains that the key is an OpenAI
platform API key for `POST /v1/decisions`, that ChatGPT or Codex Pro sign-in
does not supply it, and that calls bill the API project. A Check button is
not part of the first build: a check would be a billed call. Tests use a
mock server only.

Do not accept `apiKey`, `authorization`, env var names, or file paths as tool
arguments. Reject a definition or invoke input whose JSON contains a property
named `apiKey`, `authorization`, or `openaiDecisionsApiKey`.

### Usage lines

Write one finalized `thread_usage_lines` row per HTTP attempt that returned a
usage object. Suggested identity:

| Column | Value |
| --- | --- |
| `provider` | `openai_decisions` |
| `account_key` | `codexModelProviderAccountKey("https://api.openai.com", key)` |
| `source` | `openai_decisions` |
| `source_item_id` | `decisionId:version:x-request-id` |
| `scope` | `monitor` only if that is what keeps it off the parent turn's subscription total; otherwise a new scope the usage reader already ignores for Codex quota. The implementer must read `thread-usage-ledger.ts` and prove the line does not change the parent turn's Codex token total. |
| `model` | the `model` field echoed by the response, expected `gpt-6-luna` |
| `reasoning_effort` | null. It was not sent. |
| `service_tier` | null |
| token columns | map `input_tokens`, `cached_tokens`, `cache_write_tokens`, `output_tokens`, `reasoning_tokens` into the existing columns. `uncached_input_tokens` is the subtraction above. |
| `pricing_catalog_id` | a new catalog entry for endpoint `decisions`, output rate 0, cache rates as documented |
| `price_status` | `estimated` when the subtraction is non-negative. `unavailable` when usage is missing or inconsistent. |
| `price_unavailable_reason` | set when regional premium might apply and was not selected: `regional_premium_not_selected` does not zero the standard estimate; put the note in `pricing_basis` instead so the dollars stay the standard estimate. |

Parent attribution: set `parent_thread_id` and `thread_id` to the calling
thread so the person can see the spend on that thread. The row's provider
and account key stay the API project. Do not add the decision's tokens to
the parent turn's `thread_usage_turns` counters. Reasoning tokens stay inside
`reasoning_output_tokens` and are not also added into a second cost column.
Output cost micros are 0 because the Decisions guide says output tokens are
not charged. If `reasoning_tokens` is non-zero, keep the count and still
leave output cost at 0; record `pricing_basis` `decisions-output-uncharged`.

Long-context 2× applies only for that single response when `input_tokens` is
greater than 272,000. The catalog needs a decisions-specific rate band so
the generic OpenAI 1.5× output multiplier is not applied on top of a $0
output rate.

Org admin usage is not polled. The local ledger can disagree with the
invoice until someone reconciles with an admin key outside this feature.

### User flows

1. The operator opens Settings → AI Providers → OpenAI Decisions, pastes a
   project API key with permission to call Decisions, and optionally sets the
   project id. PwrAgnt stores the key through the existing secret store.
   Codex stays signed in with Pro; that sign-in is unused by this path.
2. In any normal thread the model calls `decisions_register` with a name, a
   choice or score or predicate, and an input schema. The tool result is the
   id and version. No HTTP call and no charge.
3. The same model, or a later turn, or another thread in the profile, calls
   `decisions_list` and then `decisions_invoke` with new evidence. The host
   validates, attaches the key, and posts to `/v1/decisions`. The model
   receives answers, probabilities, confidence, and a usage summary with
   token counts and the estimated API price. It does not receive the key.
4. The model calls `decisions_update` to change the rubric. Later invokes
   without `version` use the new version. An old pinned version still runs
   until delete.
5. `decisions_delete` stops further calls. Invoke returns `decision_deleted`.
6. If the key is missing, invoke returns `credential_missing` and does not
   send a request. Camera cues and Clef continue to depend only on the local
   decision model setting.

Claude and ACP see the same five names through the PwrAgent MCP server.
Codex sees them as dynamic tools in the `pwragent` namespace. A thread that
started before the tools existed needs a new thread or the catalog refresh
that backend already uses for other new PwrAgent tools. Registering a
decision does not refresh the Codex tool list.

### Build plan

Smallest build that makes the flows real. Tests that should fail before the
implementation exist come first.

1. Pure module `packages/shared/src/openai-decisions.ts`: bounds, canonical
   questions, request JSON, price math, redaction. No I/O. Do not export it
   from `packages/shared/src/index.ts` while the provider thread has that
   file dirty. Callers can import the module path; add the one `export *`
   line only when `index.ts` is not being edited elsewhere, and do not touch
   the provider-picker export.
2. SQLite table and store, with collision, version, scope, and delete tests.
3. `openaiDecisionsApiKey` on the secret union and a settings section that
   does not import the provider picker. Presence bit only in the renderer
   snapshot.
4. HTTP client beside, not inside, `system-one.ts`. Inject `fetch`. Tests
   use a local mock that asserts the body, the bearer header, and that the
   tool result has no `Authorization` value.
5. Five `AgentToolDefinition`s wired in `resolveAgentToolCatalogs`, included
   in dynamic specs and `buildMcpTools`. One dispatch test per transport.
6. Usage line writer and a pricing catalog entry. A regression asserts a
   Decisions line does not change a fixture Codex turn's subscription total,
   does not double-count cache tokens, and prices output at 0.
7. Dependency boundary: the OpenAI client file must not import
   `clef-camera.ts` or the System One question shape. `decision-models.ts`
   must not gain an OpenAI provider.

Out of scope for that build: image inputs, question-level images, Private
Link, admin usage polling, a live Check button, Batch, voice delegation,
and any change to Clef camera cues.

### Tests

Pinned to the create-reference shapes retrieved 2026-11-14. Fixtures live
next to the tests. No live `api.openai.com` call, no key purchase, no account
creation, no upload of a private prompt, no read of a real secret. Existing
keys stay inside the secret store and tests use a fake store.

Failing first:

- Choice, score, and predicate requests match the documented JSON, including
  `ttl: "30m"` and the absence of `reasoning` and `service_tier`.
- Questions are not placed in the cached prefix. A prefix breakpoint is on
  the developer text only.
- Duplicate active names fail. Update bumps version and cache key. Delete
  blocks invoke. Thread scope is invisible to another thread. Profile scope
  is visible inside the profile only.
- Schema rejection happens with zero fetches.
- A mock 401 returns `credential_rejected` and the result string does not
  contain the test key. Logs captured by the test do not either.
- Usage: `input_tokens` 1,000, `cached_tokens` 400, `cache_write_tokens` 100
  prices uncached 500 at $0.10/1M, cached 400 at $0.01/1M, writes 100 at
  $0.125/1M, output 0. Reasoning 7 with output 7 still costs $0 for output.
  A negative subtraction is `unavailable`, not $0.
- A 272,001-token measured request uses 2× input and cache rates and still
  $0 output.
- Provider `openai_decisions` is not selected by the Codex `openai` price
  branch.
- Tool argv that includes `apiKey` is `invalid_definition` or
  `invalid_input`.

Then the repo's lint, typecheck, build, and dependency-boundary checks for
the packages touched. Follow `apps/desktop/AGENTS.md` for how desktop tests
are run. Do not point tests at `~/.pwragent`.

### Unverified until a separate authorized live test

- The operator's project can call `gpt-6-luna` on `/v1/decisions`.
- A restricted key needs `api.decisions.write` or works with an unrestricted
  project key.
- Real `Retry-After` and `slow_down` bodies on this route match the
  platform table.
- Cache hits occur for a prefix of at least 1,024 tokens and miss below it.
- Long-context 2× is billed on this route at the model-page threshold.
- Regional processing is or is not applied when the headers are omitted.
- `reasoning_tokens` stays 0 in practice.
- End-to-end latency. The "about 10x" claim is not a SLO.
- ZDR, HIPAA, and data residency for the operator's org.

A future live test needs an explicit authorization, a project key already in
the secret store, and a public or synthetic prompt. It must record the
response `usage` and `x-request-id` without printing the key.
