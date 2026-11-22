# Agent capability policy

[Issue #2070](https://github.com/pwrdrvr/PwrAgent/issues/2070) separates an Agent's runtime ceiling from actor RBAC and Agent trust admission. Preset MCP selections and automation execution profiles request settings. They cannot increase a capability grant.

## Version 1

[The shared contract](../packages/shared/src/contracts/agent-capability-policy.ts) defines an explicit legacy policy and a restricted policy. Older Agent records have no capability field and retain their existing execution behavior. An explicit legacy policy has version 1 and mode `legacy`. Portable definitions must supply an explicit policy. The validator rejects malformed rules, unknown fields and unsupported versions.

The restricted shape requires a ceiling and lists of workspace roots, executable paths, MCP servers and tools, skill identities, and HTTP(S) origins. A null ceiling permits no execution mode. An empty list grants no access in its category. MCP tool and executable grants can require a prompt or permit auto-approval. A missing grant rejects the operation before approval. A skill cannot confer any of the permissions it needs. Network grants name individual origins, and following a redirect requires a grant for its target origin.

The schema describes the requested ceiling. Runtime admission also requires verified enforcement of the requested grants and of the default denials. A restricted policy currently has no runnable backend or launch path. Active Agent records accept legacy policies. Portable import can review and stage a restricted definition as inactive, pending a supported runtime.

When packaging a restricted definition, replace workspace roots, executable paths, MCP server identities, and skill identities with typed references to destination resources. A connection reference identifies a PwrAgent MCP connection. A provider reference identifies a server configured on the selected backend. Keep tool names and approval choices with their rules. Bind credentials separately to the connection or provider on the destination, and keep credential values out of the definition. Validate the bound policy with `validateAgentCapabilityPolicy` and check the selected backend and path with `agentCapabilityRuntimeSupport` before activation. An unresolved resource keeps the definition inactive.

## Enforcement audit

| Runtime | Interactive execution | Automation | Child execution |
| --- | --- | --- | --- |
| Codex | Thread and turn options select the provider sandbox and approval mode. Thread MCP configuration and PwrAgent's gateway can filter parts of the tool surface. The launch path lacks verified containment of all provider-native tools, hook/notification execution, workspace reads, and MCP server processes. | The runner forwards the legacy MCP server and tool allowlists. Codex applies them to configured servers, and PwrAgent also checks gateway calls. The skill allowlist has no runtime consumer. These controls cover a portion of an automation's capabilities. | PwrAgent can check an explicit launch or fork. Native subagents start inside Codex, and the shared runtime does not attest a complete inherited policy. |
| Claude | The SDK's `canUseTool` handles permission requests. The session can auto-approve tools and load provider settings. Managed hooks can survive the SDK's restrictive settings, outside the owner approval callback. | The generic headless path rejects Codex-specific MCP allowlists. It has no additional workspace, executable, skill, or network ceiling. | Native Claude tasks start inside the provider session. A PwrAgent handoff has a separate owner admission path. |
| ACP | `session/new` supplies selected MCP registrations. ACP delegates execution and native tool permissions to the installed agent. The bundled Grok helper documents observed native reads without a permission request, and inherited MCP discovery despite an empty server registration. | Each installed ACP agent retains its own configuration and execution behavior. | The provider can run work behind its session protocol. PwrAgent cannot attest propagation of a per-Agent ceiling. |

Code references

- [Codex helper configuration and MCP attestation](../packages/owner-core/src/codex-app-server/client.ts)
- [Codex automation MCP registration and gateway enforcement](../apps/desktop/src/main/app-server/thread-mcp-connections.ts)
- [Headless automation launch](../apps/desktop/src/main/app-server/headless-automation-turns.ts)
- [Claude SDK session options](../apps/desktop/src/main/claude/claude-backend.ts)
- [ACP helper restrictions and observed Grok behavior](../apps/desktop/src/main/acp/minimal-helper-session.ts)
- [Owner launch, turn, review, and fork admission](../apps/desktop/src/main/app-server/backend-registry.ts)

The owner refuses restricted or unknown policies at the checked boundaries before handing work to the provider. Provider-native child work is prevented by refusing the parent run. The Federation sender also refuses explicit restricted policies before transmitting a launch or edit to a peer, including peers that predate the field.

Admission denials emit `agent_capability_denied` with backend, thread ID when available, path, and reason. The existing main log rotates at 1 MiB. Policy payloads, paths, tool arguments, and prompts are excluded. This slice adds no per-operation SQLite writes. A runnable restricted runtime will need evidence from the enforcement point for allowed, prompted, and rejected operations, including validation that child processes and MCP servers cannot expand the effective ceiling.
