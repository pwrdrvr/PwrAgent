# Sky Computer Use with the managed Codex runtime

## Status

This is a developer-only macOS workaround recorded on September 2, 2026. It
must not become packaged PwrAgent behavior. It depends on private paths and
signing behavior in the installed ChatGPT application.

## Symptom

Sky Computer Use failed in a PwrAgent thread backed by the managed PwrAgent
Codex runtime:

```text
Sky Computer Use native pipe startup failed
```

The failure happened after this import succeeded:

```js
globalThis.sky = (await import("@oai/sky")).sky;
```

Changing the working directory or adding a `node_modules` symlink does not
address the failure.

## Evidence

The observed runtime was:

- PwrAgent Codex `0.149.0-pwragent.2`, signed by PwrDrvr LLC team
  `T44CNHC4UH`.
- ChatGPT Codex `0.150.0-alpha.8`, `node`, and `node_repl`, signed by OpenAI
  team `2DC432GLL2`.
- Codex Computer Use `26.819.1000816`, signed by OpenAI team `2DC432GLL2`.

The Computer Use service logged `Sender process is not authenticated` for the
failing native-pipe connection. An A/B probe used the same OpenAI `node_repl`
binary and environment in both cases:

| Parent chain | Result |
|---|---|
| Ordinary or PwrAgent-signed parent → OpenAI `node_repl` | Native-pipe authentication failed |
| OpenAI-signed `node` → OpenAI `node_repl` | Native-pipe connection succeeded |

The successful probe then reached MCP form elicitation. That later failure was
expected because the minimal probe client did not advertise form-elicitation
support. The important distinction was that the native-pipe authentication
error was gone.

## Local workaround

The helper changes the configured `node_repl` stdio command from a direct
launch to this chain:

```text
managed Codex
  → ChatGPT's OpenAI-signed cua_node/bin/node
    → ~/.pwragent/local/openai-node-repl-trampoline.cjs
      → ChatGPT's OpenAI-signed cua_node/bin/node_repl
```

It uses the public `codex mcp` CLI, preserves every existing `node_repl`
environment value, verifies the replacement, and restores the original
registration automatically if the update fails. It does not read Codex-owned
configuration files directly. Before changing a non-trampoline launcher, it
records only that launcher's command and arguments under `~/.pwragent/local/`;
environment values remain in Codex's registration and are not copied into the
backup.

Inspect without changing anything:

```bash
pnpm dev:sky-computer-use -- --status
```

Install the workaround:

```bash
pnpm dev:sky-computer-use -- --apply
```

Then fully restart PwrAgent or reload its Codex MCP servers. Already-running
`node_repl` processes keep their original parent chain.

Restore the direct launcher:

```bash
pnpm dev:sky-computer-use -- --restore
```

When an original-launcher backup exists, `--restore` uses it. Otherwise it
restores ChatGPT's bundled `node_repl` directly.

For a nonstandard ChatGPT installation or PwrAgent root, pass
`--chatgpt-app <path>` or `--pwragent-root <path>`. Pass `--codex <path>` to
select the Codex CLI used for the public `mcp get`, `remove`, and `add`
operations.

## Why this must remain developer-only

- `/Applications/ChatGPT.app/Contents/Resources/cua_node` is not a public
  PwrAgent runtime contract.
- ChatGPT updates can replace the Node REPL, Sky package, service, and protocol
  independently of PwrAgent.
- The workaround changes a machine-wide Codex MCP registration.
- A symlink does not change the responsible process or its signing identity.
- The next compatibility boundary may be form elicitation in the managed Codex
  fork.

A durable product fix needs a supported OpenAI authentication/broker contract
for third-party Codex hosts or a Computer Use service that explicitly accepts
the PwrDrvr signing identity. Codex documents MCP command and argument settings
in the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
but Sky's native-pipe authentication is not a public integration surface.
