# ACP Registry Backends

PwrAgent can consume allowlisted Agent Client Protocol (ACP) coding agents as
desktop backends. ACP is a client protocol for external coding-agent processes;
it is not raw model-provider access and it does not move PwrAgent's own Agent
Core behind ACP.

## What ACP Adds

- Registry discovery for ACP-compatible coding agents.
- Per-agent backend identities such as `acp:gemini`, alongside `codex` and
  `grok`.
- Profile-state install records that preserve distribution source, allowlist
  rule, verification state, auth state, and launch descriptor.
- ACP session metadata in the same navigation/thread model used by built-in
  backends.
- Client-owned mediation for ACP permission requests and prompt cancellation.

## Allowlist Policy

PwrAgent does not expose the public ACP registry wholesale. A registry entry is
installable only when a PwrAgent allowlist rule permits its registry id,
version, distribution kind, and package/archive source. GPL-family licenses are
blocked unless a future rule explicitly allows a specific entry.

The current launch allowlist lives in
`apps/desktop/src/main/acp/acp-agent-allowlist.ts`.

## Distribution Support

Supported launch forms:

- `npx` package descriptors.
- `uvx` package descriptors.
- Platform binary archives.

Package descriptors are stored as argument arrays and launched without shell
string interpolation. Binary installs use a staging directory before promotion.
Checksum/signature metadata is verified when present. If a binary source lacks
integrity metadata, it is installable only when the allowlist rule explicitly
permits that exact unverified source, and Settings surfaces that state.

## Trust Boundary

PwrAgent currently advertises ACP client filesystem and terminal capabilities
as unsupported and handles only `session/request_permission` on the reverse
request path. Default Access and Full Access affect that permission flow, but
they do not turn an external ACP process into a PwrAgent-sandboxed process.
PwrAgent cannot mediate filesystem, terminal, network, or subprocess behavior
that an external agent performs internally. Treat installed ACP agents as
third-party local executables with their own credential and operating-system
access.

## Runtime State

ACP registry cache, installed-agent records, and ACP session metadata live in
the active PwrAgent profile sqlite database under `~/.pwragent/profiles/<name>/`.
Installed agents continue to be listed from profile state when the registry is
temporarily unavailable.

Runtime discovery follows these rules:

- Runtime capability discovery uses a hidden scratch session and never creates
  a user-visible PwrAgent thread.
- Persist discovered runtime capabilities separately from curated ACP product
  capabilities.
- User-facing controls prefer ACP `configOptions` and use `modes` only as a
  compatibility fallback.
- ACP runtime options remain separate from PwrAgent `ThreadExecutionMode`.
- Discovery failures preserve runnable records, while successful snapshots
  refresh after forty-eight hours, version changes, or forced requests.

ACP session metadata does not include full transcript history. Providers that
support `session/load` remain the source of truth for restored ACP transcripts.
If PwrAgent later needs to persist fallback history for an ACP provider that
cannot restore its own sessions, use append-only JSONL rollout files rather
than sqlite; see [thread-history-persistence.md](thread-history-persistence.md).

## Rollout Notes

Ship with a narrow allowlist. Add new agents only after agent-specific smoke
testing covers install, launch, session creation, prompt turn, cancellation,
permission requests, rejection of unsupported reverse requests, auth/setup
status, and registry-unavailable startup.

## Managed Claude Runtime

Claude is exposed as `acp:claude-acp`. It is a PwrAgent-managed exception to
the general local-CLI discovery path, not a new agent-kit strategy:

- Claude is Experimental and defaults off. It appears under AI Providers only
  after the operator enables **Experimental → Claude Agent through ACP**. When
  that flag is off, PwrAgent also blocks installation and launch and omits
  Claude from local and federated backend capabilities.
- PwrAgent installs the external
  `@agentclientprotocol/claude-agent-acp@0.60.0` executable under the active
  profile's `state/acp-runtimes/` directory. It is not a desktop-app or
  agent-kit dependency.
- Installation requires Node.js 22 or newer plus npm on the owning instance.
  npm lifecycle scripts are disabled. Before an installation is promoted,
  PwrAgent verifies the package name, exact version, executable entrypoint, and
  the checked-in npm SHA-512 integrity value, then hashes the complete installed
  package tree against a checked-in SHA-256 content digest.
- Runtime launches go through PwrAgent's normal ACP stdio transport and owned
  process-tree shutdown. PwrAgent launches the adapter with no adapter-specific
  arguments, matching its normal local-authenticated behavior.
- Cached readiness is reused only after the on-disk package bytes and
  entrypoint pass the same pin checks. A removed or altered runtime becomes
  unavailable and must be reinstalled before PwrAgent will launch it.
- Authentication is an explicit local setup step. Settings provides both the
  adapter's `--cli auth login --claudeai` subscription command and its
  `--cli auth login --console` command for the operator to run in a terminal,
  then uses an ACP session probe to mark the runtime ready. PwrAgent's generic
  ACP client does not advertise terminal-auth handling; these commands are the
  intentionally explicit local flow. PwrAgent does not receive, store, log, or
  transport the resulting credential.
- An authenticated readiness probe discovers the account's available models
  and the model-dependent effort choices advertised by the adapter. Prompt
  results populate PwrAgent's turn token-usage and pricing state; ACP
  `usage_update` notifications populate context-window occupancy separately so
  cumulative context is never mispriced as per-turn spend.

The package pin is deliberately independent of the moving public ACP registry.
An upgrade requires updating the package version, integrity value, allowlist
rule, tests, and authenticated smoke-test evidence together.

### Federation and credential ownership

The thread's owning PwrAgent instance launches Claude beside the workspace and
reads credentials from that instance's local Claude credential store. Remote
instances may receive the backend's availability, version, capabilities, and
the `owning-instance` credential-scope marker through the existing federation
backend APIs. They never receive an Anthropic API key, OAuth token, credential
file, or authentication command, and they never launch a second adapter for a
remotely owned thread.

### Anthropic policy boundary

[Anthropic's Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk)
directs third-party products to use API key authentication through Anthropic
Console or a supported cloud provider. Its
[authentication policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
prohibits offering Claude.ai login or routing Free, Pro, or Max plan
credentials on users' behalf. The community adapter supports local Claude.ai
login, and other open-source ACP clients expose that flow, but no public
evidence reviewed for this integration establishes Anthropic approval for
PwrAgent to do so.

PwrAgent therefore labels the entire provider Experimental, requires a
specific opt-in, keeps authentication and execution on the owning instance,
and shows the policy caveat beside the controls. Those mitigations do not
resolve the underlying terms question. Subscription authentication should
receive legal/policy review or explicit Anthropic approval before it is treated
as generally supported or enabled by default.

The adapter is Apache-2.0, but its bundled Anthropic Agent SDK and the service
remain subject to Anthropic's commercial terms, usage policy, supported-region
rules, and operator account agreement. PwrAgent does not make an independent
claim that a particular enterprise gateway, cloud-provider credential flow, or
resale/deployment model is authorized. Those paths remain operator-managed and
should receive legal/policy review before PwrAgent adds first-class setup UI.

The community adapter labels `--console` as Anthropic Console authentication
with API usage billing. PwrAgent has not independently established that this
interactive credential mechanism is contractually equivalent to the API-key
authentication Anthropic prescribes for third-party products. Confirm that
point with Anthropic before broad distribution; if it is not approved, replace
the interactive command with an explicit local API-key setup flow.
