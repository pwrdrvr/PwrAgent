# How Agent instructions reach the model

An operator gives an Agent a name and instructions. The instructions shape
every turn of the Agent's thread, on every backend, and an edit applies from the
next turn. This file states how each backend delivers them and why.

The text lives in the thread's overlay as `agent.instructions`
(`ThreadAgentMetadata` in `packages/shared/src/contracts/navigation.ts`).
`providerDeliveredAgentInstructions` in
`apps/desktop/src/shared/agent-instruction-delivery.ts` is the one place that
decides whether PwrAgent itself must send it.

## Per backend

| Backend | At thread start | On resume | After compaction | After an edit |
|---|---|---|---|---|
| Claude | Appended to the `claude_code` system prompt | The system prompt of the relaunched process | The system prompt is not compacted | The next turn relaunches the session with the new prompt |
| Codex | `developerInstructions` on `thread/start` | `developerInstructions` on every `thread/resume` | Codex re-sends the loaded session's developer instructions | The thread is reloaded with the new text, and one developer message announces it |
| ACP | A marked text block at the front of the first `session/prompt` | Nothing is sent: the block is in the session's history | Not visible to PwrAgent, see the limit below | The next `session/prompt` carries the new block |

### Claude

`startTurnNow` in `apps/desktop/src/main/app-server/backend-registry.ts`
passes the text to `ClaudeBackend.startTurn`, which sets
`systemPrompt: { type: "preset", preset: "claude_code", append }`. The system
prompt is fixed when the Claude process starts. A changed text makes the next
turn close the session and resume it in a new process. While a background task
runs, the change waits for the next launch. See
[claude-provider.md](claude-provider.md).

### Codex

The Codex App Server protocol accepts `developerInstructions` on
`thread/start` and `thread/resume`. Codex 0.164 treats it this way, read from
`codex-rs` at tag `rust-v0.164.0`:

- The text becomes part of the session's configuration when the thread is
  loaded. Codex does not store it with the thread, so a resume that loads the
  thread must carry it again.
- Codex shows it to the model as a developer message when it builds a full
  context: on the first turn, and after each compaction.
- A `thread/resume` that rejoins a thread already loaded ignores the field.
- Codex loads an idle thread again only when no connection is subscribed to it
  and the resume carries an override.

So the client sends the text in three places
(`packages/owner-core/src/codex-app-server/client.ts`):

1. `thread/start` carries it for a new Agent thread.
2. Every `thread/resume` carries it. The registry gives the client a resolver
   (`provideThreadDeveloperInstructions`) and the client fills the field in at
   its two request funnels. Any resume can be the one that loads a thread after
   a restart: a compaction, a rewind or a steer, not only a turn. One sent
   without the text would leave the session with no instructions to restore
   after its next compaction.
3. An edit is applied between turns by `replaceThreadDeveloperInstructions`.
   It unsubscribes, resumes with the new text so that Codex loads the thread
   again, and appends one developer message with the new text through
   `thread/inject_items`. The reload is what later compactions restore. The
   message is what the next turn reads, because a reload does not rebuild the
   context.

`setThreadAgent` queues a change behind an active Codex turn, so the running
turn keeps the text it started with. A thread that has not run its first turn
has no rollout to reload from. It gets the message at once and the reload
before its second turn.

The text takes the place of `developer_instructions` from Codex configuration
for that thread. Codex 0.164 resolves the field as
`developer_instructions.or(cfg.developer_instructions)`
(`codex-rs/core/src/config/mod.rs`), so a request value wins and the configured
value is dropped, whichever layer set it: user, profile, project or `-c` flag.
A thread without an Agent sends no override and keeps the configured text.
Managed `additional_developer_instructions` is a separate field and still
applies.

This is deliberate. An operator who wants configured text on an Agent thread
puts it in the Agent's instructions. Combining the two was considered:
`config/read` with the thread's `cwd` returns the configured value, so the
client could send it ahead of the Agent's text. It was not adopted, to keep
the Agent's instructions the one text that reaches the model.

Two other fields were considered and not used.
`collaborationMode.settings.developer_instructions` on `turn/start` is
experimental, replaces the built-in mode instructions, and is dropped without
notice for a model whose catalog entry supplies its own collaboration-mode
text. `additionalContext` on `turn/start` is experimental and is not restored
after compaction.

### ACP

The Agent Client Protocol has no instruction field. `session/new` accepts
`cwd`, `additionalDirectories`, `mcpServers` and `_meta`, and `_meta` carries
only vendor extensions. Every agent must accept text blocks in
`session/prompt`, so the instructions travel there.

`AcpAgentClient.startPrompt` (`apps/desktop/src/main/acp/acp-client.ts`) puts
one marked text block ahead of the operator's prompt when the agent session
has not been sent the current text:

- the first prompt after `session/new`;
- the first prompt after the text changes, including a removal. A prompt that
  is already running is not touched.

A `session/load` sends nothing. It follows an app restart and every idle
close, which happens after 10 minutes without activity, so a block per load
would repeat the instructions on most turns of a quiet thread. The block is
part of the session's history, and the agent restores that history on load.

The record of what a session was sent is `agentInstructionsDigest` on the
session's row in `acp_sessions`: a SHA-256 of the agent session id and the
text, not the text. A thread bound to a new agent session has no matching
digest and is sent the block. A prompt the agent rejects leaves the block due
again.

ACP agents echo each prompt back as a `user_message_chunk`. The transcript
filter (`stripAcpAgentInstructionChunk`, which follows a block across the
chunks of one echoed message) removes the block by its markers, the
way `stripManagedReviewContextBlock` removes a review artifact. Change a marker
in one place and the block renders as something the operator typed.

Known limit: ACP does not report compaction. An agent that compacts its
history may summarize the block away, and PwrAgent does not send it again
until the text changes or the thread gets a new agent session.

## Agents whose workspace holds the instructions

The Star Map and Voice managers own their working directory and keep their
persona there in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `QWEN.md`. Their
`agent` metadata carries `instructionsDelivery: "workspace-file"`, and
`providerDeliveredAgentInstructions` returns nothing for it. Each backend
therefore delivers a manager's persona once, from the file. See
[star-map-manager.md](star-map-manager.md#how-the-manager-gets-its-instructions).

Only an Agent that owns its working directory may use a workspace file. An
Agent working in a repository never has files written into that repository.

## Writes

Delivery adds no SQLite write per turn. The Codex resolver reads the overlay.
The ACP client writes the session row once per delivered block: on the first
prompt of an agent session and on the first prompt after an edit. A manager thread created before
`instructionsDelivery` existed gets the marker in one write the next time it is
opened.

## Tests

`apps/desktop/src/main/__tests__/agent-instruction-delivery.property.test.ts`
asserts all of this at the provider request boundary: the Codex JSON-RPC
frames, the ACP `session/new` and `session/prompt` frames, and the options the
Claude Agent SDK query starts with.
