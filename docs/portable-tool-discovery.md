# Portable discovery through model providers

The existing Codex Code Mode runtime can discover and invoke deferred MCP tools
through ordinary Responses function calls when a transport adapts its freeform
`exec` tool. This is validated against a synthetic provider oracle, not a live
MathOS model. Providers can now opt into this transport from Settings; selecting
one of their verified models routes normal Codex threads through it.

## Contributor verification in the product

1. In **Settings → Models → Model providers**, edit the provider.
2. Set **Tool discovery** to **Portable** and choose **Model to test**.
3. Click **Test connection**. The portable result must say **Verified through
   Codex**; a provider-native search failure can remain visible independently.
4. Click **Save and reconnect**, then start a new thread with that provider's
   verified model in the normal model picker.

Test each additional model before using it in Portable mode. Unverified models
produce a clear Settings instruction rather than silently exposing their full
catalog. **Provider default** retains the existing transport. Changing discovery
mode calls for a new thread; native search history is not silently rewritten.
Provider changes retain the existing idle-boundary reconnect behavior.

The portable connection check runs a real, isolated Codex process with a unique
deferred read-only fixture. It requires discovery, one actual invocation and the
exact marker in an App Server completion event. It uses at most six inference
requests and a two-minute turn deadline. Together with the existing native
checks, Test connection can send up to ten inference requests. The result shows
the fixture check's request count and initial tool/request bytes; those numbers
are not measurements of the operator's full integration inventory.

The stored provider key follows the existing main-process/App Server injection
path and is blanked from model shell environments. The temporary Codex home
contains no key. A keyed provider's private loopback transport requires the same
Bearer credential before forwarding. Probe diagnostics remain in memory and
only bounded counts/sizes return to Settings; normal turns add no diagnostic
persistence. Native and portable verification are stored separately in
endpoint-bound model metadata. The new `tool_discovery = "portable"` provider
field is additive; no operator configuration is changed by development checks.

The normal route refuses eager third-party namespaces and caps the complete
exec definition at 32 KiB before forwarding. This cap includes the existing
PwrAgent bootstrap and core tools. A capture with PwrAgent's real search
bootstrap, 106 deferred dynamic registrations and 1,000 MCP fixtures contained
a 19,509-byte exec definition with no fixture names exposed. The separate
16 KiB synthetic discovery target below uses the smaller isolated core fixture;
it is not an absolute cap on all of PwrAgent's existing core guidance.

Product requirements remain in the draft
[Linear PRD](https://linear.app/pwrdrvr/document/prd-portable-tool-discovery-through-the-codex-harness-159212c72fc9).
The remaining release gates below are separate from this usable opt-in route.

## Verified harness and configuration

The tested executable is `codex-cli 0.163.0-pwragent.1`, installed under
`~/.pwragent/agents/codex/versions/pwragent-v0.163.0-pwragent.1/`.
Its SHA-256 is
`3251df5286a573c14be505ed49df3b77b5c73e9e0f247cceaeedb9d6979bcf03`;
`PWRAGENT-BUILD.txt` identifies source `4b08d17acb6a44b7cee9da3f0ce367d1d1fd9090`.
The sibling `codex-code-mode-host` is required. Other versions are unverified.

The probe records its exact process overrides, model metadata and `thread/start`
settings with temporary paths redacted. It supplies whole `features` and
`mcp_servers` request tables alongside process overrides. It uses a temporary
Codex home, read-only MCP fixtures, ephemeral threads, `approvalPolicy: never`
and the read-only sandbox. No operator configuration, credentials, MCP selection
or running processes are changed.

The adapter-facing catalog sets `tool_mode: code_mode_only` and
`supports_search_tool: true`. The request enables `code_mode`, `code_mode_only`
and `code_mode_tool_search`. The true value describes the local adapter/harness
contract; **raw upstream native search remains false in the oracle**. Never
write that value into a provider's native verification record.

Installed-source inspection confirms that `supports_search_tool` gates both
search registration and deferred guidance. The nested handler already accepts
ordinary Function arguments when its source is Code Mode and returns JSON
metadata with callable TypeScript declarations. Its direct path uses native
search items. Current fork main `280d56b1d823a7e9dfd85f796da38bd825d0052d`
retains the model-capability gate through `search_tool_enabled`; source presence
is not installed-binary validation.

## Transport and execution ownership

`portable-code-mode-transport.mjs` exposes an opt-in owner API taking a `send`
closure. The owner retains authentication and endpoint selection. The transport
never reads stored keys or chooses an upstream itself. The provider runtime
supplies a private local URL without changing the persisted endpoint. Generic
providers retain Responses instructions/content. Bonsai retains its required
compatibility bridge underneath portable translation, with integrations kept
enabled. PR #3742 is independent and unchanged.

The installed binary sends tool definitions in `additional_tools` input items.
The transport resolves those snapshots into ordinary upstream function specs,
including a JSON `{code: string}` contract for the existing Lark/freeform `exec`.
Canonical namespace/name pairs have stable hashed wire identities. Reverse
translation restores Codex's original namespace, name, call ID and raw source.
History uses ordinary function calls/results upstream. No native search items,
freeform specs or `additional_tools` reach the ordinary-only provider.

Codex executes the source in its existing Code Mode host. The source calls
`tools.tool_search`, prints the returned callable declaration, then calls that
selected MCP tool. PwrAgent never executes an MCP tool or interprets JavaScript.
The adapter has no registry or tool-authorization cache. Codex retains its
existing registry, argument validation, MCP ownership and policy routes.

SSE argument fragments remain buffered until the complete JSON code string is
available. Codex receives the original source in the completed custom-call item.
Buffered upstream responses can also be synthesized into Codex's SSE sequence.
Malformed JSON/incorrect code shapes become a side-effect-free error through
Codex's executor so the model can retry. Cancellation reaches the owner's
request signal; the transport never retries a request. Text/images in tool
results pass through unchanged. Unknown native tools and implicit remote history
references fail explicitly. Requests and individual buffered responses/frames
are capped at 16 MiB. Diagnostics contain only sizes, counts and stage names.

## Reproduce

From this worktree, with the installed binary and its sibling Code Mode host:

```sh
mkdir -p .local
node scripts/probe-codex-portable-discovery.mjs --matrix \
  ~/.pwragent/agents/codex/versions/pwragent-v0.163.0-pwragent.1/codex \
  > .local/portable-matrix.json
pnpm test scripts/portable-code-mode-transport.property.test.mjs
```

The matrix uses a synthetic ordinary-Responses provider in the owning process.
It does not require a provider key or contact an external inference service.
Its eight complete exchanges cover 100/500/1,000 tools with streaming and
buffered upstream responses, plus malformed argument recovery in both modes.
Every exchange requires discovery, acceptance of the actual returned callable,
one real selected MCP invocation and an exact unique marker in the final
App Server agent message. The oracle returns the marker only after observing
it in the tool result. All task-owned processes and temporary homes are removed.

Measured on the binary above:

The app-owned `verifyPortableProvider` entry point also completed the real Codex
exchange against a synthetic Responses provider in both buffered and streaming
modes. Each took three requests, with 14,434 initial tool bytes and 29,530 initial
request bytes. This exercises the product connection-test implementation and
its unique deferred dynamic fixture. The larger MCP matrix below uses the
original controlled fixture/configuration for the inventory comparison.

| Inventory | Direct tool bytes | Portable tool bytes | Direct request bytes | Portable initial request bytes |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 92,179 | 17,472 | 100,866 | 26,159 |
| 500 | 382,979 | 17,472 | 391,666 | 26,159 |
| 1,000 | 746,479 | 17,472 | 755,166 | 26,159 |

Portable definitions comprise the conservative full `exec` definition (14,671
bytes, including core nested tool guidance) and 2,801 bytes of other core specs.
Initial instructions/history are 7,305 bytes in every control and candidate.
No initial third-party schemas are advertised. The 1,000-tool comparison reduces
total tool-definition bytes by 97.66%; this is not a token or total-context claim.
The initial tool count is three: exec plus existing core control functions.

The selected search output is 822 bytes. Ordinary successful request totals are
26,159 → 27,345 → 27,918 bytes, with three specs throughout. Malformed recovery
adds one request: 26,159 → 26,838 → 28,024 → 28,597 bytes. The complete matrix
records the binary and adapter hashes, exact configuration, initial/follow-up
counts and bytes, search-result size and inherited-MCP isolation result.

Without the adapter-facing discovery capability, Code Mode alone sends a
90,192-byte exec definition for the 100-tool fixture. Counting only its three
top-level specs would hide the failure.

Checked-in budgets enforce a 16 KiB exec definition, 32 KiB observed search
result, constant initial tool/exec/instruction sizes across inventories, at most
three initial specs and at least 90% large-fixture tool-byte reduction.
These are synthetic-fixture gates, not general enforcement of every PRD budget.

## Remaining release gates

The installed binary **fails configuration isolation**: the inherited synthetic
MCP remains enabled despite a process disable when the request supplies whole
tables. Gate production on [Codex #20](https://github.com/pwrdrvr/codex/pull/20)
or an equivalent verified fix. Do not substitute dotted request keys and claim
compatibility. Protocol success is independent of this failure.

The probe explicitly searches with limit five; this Codex handler defaults to
eight and does not enforce the PRD maximum ten or a universal 32 KiB result cap.
Those limits and a per-turn search budget belong in the owning harness, not
source-code rewriting in this adapter. Large schemas are not covered yet.

Live MathOS Kimi acceptance, a native-provider control, Apps, approval waits and
denial, invocation-time revocation, connection loss, schema/catalog revisions,
resume, concurrent searches and full result-type parity remain unverified.
Transport tests cover identity, JSON recovery, image preservation, UTF-8/SSE
fragmentation, cancellation and no transport retries; those tests do not prove
every corresponding harness lifecycle invariant. Automatic selection requires
owner-scoped capability evidence and version gates before enabling any default.

No new turn/event persistence is added (zero additional SQLite commits and MB/day).
The provider fields use the existing explicit Settings save operation.
The probe's local artifact and MCP invocation log are task-owned test files.
