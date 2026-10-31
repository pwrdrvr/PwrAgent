# PwrAgent MCP workflow skills

PwrAgent serves app-bundled workflow Markdown through `resources/list` and
`resources/read`, and URI-based manifests through the
`io.modelcontextprotocol/skills` extension's `skills/list` and `skills/get`.
`skills/get` returns frontmatter and a resource manifest, not the Markdown body.
Each manifest includes the content's UTF-8 byte count and SHA-256 digest.

The shipping list is explicit. URIs never resolve to operator files, repository
files, or arbitrary filesystem paths. Reads use the same authenticated loopback
endpoint as tools, but need no active turn: clients discover context before
starting one. The separate PDF-only MCP surface has an empty skill catalog.
The existing MCP SDK's initialization/transport negotiation remains in use;
this change does not implement the newer `server/discover` transport protocol.

`waiting-on-work` owns the cross-tool choice between PR watches, thread
dependencies, and monitors, and explains why the parent should end its turn.
Detailed per-tool procedures and argument/result contracts remain in tool
descriptions and schemas. `tool-guide` owns the short tool selection guide.
`read_tool_guide` retains its name, schema, and response envelope and returns
the same authored skill bodies for clients that can only consume tools.

## Client evidence (2026-10-30)

MCP resources, prompts, native filesystem skills, and MCP-served skills are
different discovery mechanisms. Listing a resource or prompt does not inject
its body into the model. ACP supplies MCP connection information to the agent;
it does not require that agent to support any particular MCP primitive. The
current PwrAgent strategies cover Gemini, Grok, Kimi Code, and Qwen Code.

| Client / evidence | MCP skills extension | Resources | Prompts | Automatic workflow loading |
| --- | --- | --- | --- | --- |
| Claude Agent SDK **0.3.303**, bundled runtime manifest **2.1.303**; discovery-only live probe below | No `skills/list` or `skills/get` request, even with modern discovery and the extension advertised | Requests `resources/list` at discovery; built-in list/read tools are model-accessible. `@server:uri` also loads content on user reference. | Requests `prompts/list`; returned prompt appears in `supportedCommands()`. User invocation injects its messages. | No resource read or skill load in either probe. Keep the CI instruction sentence. |
| Codex; official docs plus source at **f2ac9983552d187aa1c9a53c4707cf3b2c4afde6** | No MCP skills operations in the inspected MCP integration. Codex's App Server `skills/list` discovers local/plugin skills; it is not this MCP extension. | Model tools list/read resources on demand; App Server can also enumerate and read them. | No list/get prompt operation in the inspected MCP client API; no automatic prompt injection established. | Server `instructions` are model guidance; resource content is read on demand. |
| Gemini CLI; current official documentation and MCP discovery source | No skills operations in the inspected MCP discovery implementation | Discovers resources; `list_mcp_resources` and `read_mcp_resource` are model tools. | Discovers prompts when advertised; exposes invocation separately as slash commands. | Resource tools make content reachable, not automatically loaded as a skill. |
| Qwen Code **0.26.1** installed bundle and tagged source; current official MCP docs | No `skills/list` or `skills/get` string in installed JS chunks | Discovers resources; has a model `read_mcp_resource` tool. Interactive `@server:uri` reads content into a message. | Discovers prompts as executable slash commands; documented ACP startup waits for discovery. | No MCP-skill auto-loader established; resource reading is explicit. Interactive command/reference UI is not a guarantee that an ACP host exposes it. |
| Grok; PwrAgent-managed source **be713136d2a69080743a3f6b3c72077057e5948f** | No skills operations in the inspected MCP integration | `McpStateResourceProvider` is injected into agent shared resources so tools can enumerate and read them; also has an ACP resource-read extension. | No prompt list/get integration found in the inspected MCP server/client and agent extension modules. | Resources are requested on demand; no automatic skill loading established. |
| Kimi Code (current TypeScript CLI, not legacy Python kimi-cli); source **a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55** | No skills operations in the inspected MCP client interface/discovery | Core client exposes listTools, callTool, and ping; discovery connects then calls listTools. No resource interface exposed there. | No prompt interface exposed there. | Tools-only integration in the inspected source; use the compatibility guide tool. |

The Claude row is a runtime observation at connection startup. The other rows
are documentation/source audits, not paid model behavior tests. Absence claims
are limited to the identified client interfaces and discovery paths; future
agent versions or separately installed native skills can behave differently.
PwrAgent does not install files into these agents' skill directories.

### Reproduce the Claude discovery probe

```sh
node apps/desktop/scripts/probe-mcp-skill-discovery.mjs
node apps/desktop/scripts/probe-mcp-skill-discovery.mjs --modern
```

The probe connects the bundled SDK to an invented loopback MCP server with a
tool, prompt, and skill resource. It calls SDK control APIs without ever
yielding a user prompt, so it requests no model turn. It disables filesystem
settings, uses strict MCP configuration, and does not persist a session.

Observed in both runs: the probe server connected and
`probe:waiting-on-work (MCP)` appeared in `supportedCommands()`.

```text
Legacy: server/discover (method not found), initialize,
        notifications/initialized, tools/list, prompts/list, resources/list
Modern: server/discover, prompts/list, resources/list, tools/list
```

Neither run requested `skills/list`, `skills/get`, `resources/read`, or
`prompts/get`. The modern response used PwrSuiteLab's `2026-07-28` discovery
shape with `capabilities.extensions["io.modelcontextprotocol/skills"]`.

### Sources

- [Claude MCP resources, tool search, and prompts](https://code.claude.com/docs/en/mcp): resources are fetched on reference; resource tools are automatically provided; deferred tool search initially loads names and server instructions; prompts become commands.
- Bundled SDK evidence: `apps/desktop/package.json`, `@anthropic-ai/claude-agent-sdk/manifest.json`, and `sdk.d.ts` (`settingSources`, `strictMcpConfig`, `skills`, `supportedCommands`, `mcpServerStatus`). Its native `skills` option filters discovered filesystem/plugin skills; it does not establish MCP extension support.
- [Codex MCP instructions](https://developers.openai.com/codex/mcp#supported-mcp-features), [Codex App Server API](https://learn.chatgpt.com/docs/app-server#api-overview), [Codex resource handlers](https://github.com/openai/codex/tree/f2ac9983552d187aa1c9a53c4707cf3b2c4afde6/codex-rs/core/src/tools/handlers/mcp_resource), and [MCP client API](https://github.com/openai/codex/blob/f2ac9983552d187aa1c9a53c4707cf3b2c4afde6/codex-rs/rmcp-client/src/rmcp_client.rs).
- [ACP session setup](https://agentclientprotocol.com/protocol/session-setup): connection descriptors passed to agents.
- [Gemini resource tools](https://geminicli.com/docs/tools/mcp-resources/) and [MCP discovery implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts) (`discoverPrompts`, `discoverResources`).
- [Qwen MCP discovery and command/reference behavior](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/) and [0.26.1 resource tool](https://github.com/QwenLM/qwen-code/blob/v0.26.1/packages/core/src/tools/read-mcp-resource.ts). The installed 0.26.1 bundle also contains listResources/listPrompts discovery calls and the resource tool registration.
- [Grok agent resource provider](https://github.com/pwrdrvr/grok-build/blob/be713136d2a69080743a3f6b3c72077057e5948f/crates/codegen/xai-grok-shell/src/extensions/mcp.rs) and [MCP clients](https://github.com/pwrdrvr/grok-build/blob/be713136d2a69080743a3f6b3c72077057e5948f/crates/codegen/xai-grok-mcp/src/servers.rs).
- [Kimi Code client interface](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/mcpCore/types.ts) and [connection/discovery](https://github.com/MoonshotAI/kimi-code/blob/a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55/packages/agent-core-v2/src/mcpCore/connection-manager.ts) (`connectAndDiscoverTools`).
- Reference inspected locally: PwrSuiteLab `lab-control/skill_catalog.py`, `lab-control/mcp.py`, and `tests/test_mcp_skills.py`. Its extension manifests and resource fallback supply this server's wire shapes; its modern transport negotiation is independent of the skill catalog.
