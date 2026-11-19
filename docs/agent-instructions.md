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
| ACP | A marked text block at the front of the first `session/prompt` | Nothing is sent: the block is in the session's history | The next `session/prompt` carries the block again, see [compaction](#acp-compaction) | The next `session/prompt` carries the new block |

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

### ACP compaction

ACP has no compaction notification. All four supported agents compact a long
session on their own, and a summary may drop the block. PwrAgent cannot see
what a compacted context holds. A `session/load` replay is the transcript the
agent shows, not the context the model gets, and some harnesses encrypt the
compacted result. So the client acts only on what an agent reports live.

`AcpAgentClient` treats either of two live signals as a compaction:

- Grok's `auto_compact_completed` on `_x.ai/session_notification`, sent for
  its own compactions (at 85% of the context window by default) and for
  `/compact`.
- A `usage_update` whose `used` is below half of the last one the session
  reported. Kimi, Qwen and Gemini each report the current context fill there,
  and the fill only grows between compactions. Qwen sends no fill for a
  sub-agent. The last fill is kept in memory for the agent session that
  reported it, so a thread bound to a new agent session starts a new
  baseline, and a compaction in the first turn after an app restart goes
  unseen. Pruning old tool results (Qwen's microcompaction, Gemini's output
  masking) can also halve the fill; that costs one redundant block.

On either signal the client clears `agentInstructionsDigest`, so the next
prompt carries the block. If the compaction ran inside the prompt that
delivered the block, that delivery is not recorded. Signals that a
`session/load` replays are ignored, so loading a session still sends nothing.

Measured on 2026-11-18:

| Agent | Compacts on its own | What the client receives |
|---|---|---|
| Grok 1.0.89 | Yes, `[session] auto_compact_threshold_percent`, default 85 | `auto_compact_completed` with `tokens_before` and `tokens_after`. A `/compact` with nothing to shrink still sends one, with equal counts |
| Kimi Code 2.0.0 | Yes, when free context falls below `loop_control.reserved_context_size` | `agent_message_chunk` text: "Compacting conversation context", then "Compaction completed." with counts. `usage_update` after each turn with the current fill |
| Qwen Code 0.27.2 | Yes, thresholds computed from the model's context window | An `agent_message_chunk`: "IMPORTANT: This conversation approached the input token limit for <model>. A compressed context will be sent for future messages …". `usage_update` with the prompt's token count |
| Gemini CLI 0.68.0 | Yes, `model.compressionThreshold`, default 0.5 | No compaction update. `usage_update` after each model call, with prompt plus output tokens as `used` |

Kimi's, Qwen's and Gemini's rows come from their published ACP code. The Kimi
account used for the capture had no Kimi Code access (403), and Gemini and
Qwen were not installed. Kimi's compaction keeps user messages verbatim
while they fit its retention budget, oldest dropped first, and the block is
in the oldest one.

Whether a model still follows the block after a real compaction was not
measured. In a Grok capture, replies ended with a word the block asked for
before and after a `/compact`, but that compaction shrank nothing (19,202
tokens before and after). A longer session timed out before it compacted, and
two of its long replies had already dropped the word. The resend rests on
what the agents report, not on observed loss.

The reply text is not used: it is prose that can change between releases.

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
prompt of an agent session and on the first prompt after an edit, and clears
it once per detected compaction (budget
`acp-compaction-instruction-redelivery`). The context fill is kept in memory. A manager thread created before
`instructionsDelivery` existed gets the marker in one write the next time it is
opened.

## Tests

`apps/desktop/src/main/__tests__/agent-instruction-delivery.property.test.ts`
asserts all of this at the provider request boundary: the Codex JSON-RPC
frames, the ACP `session/new` and `session/prompt` frames, and the options the
Claude Agent SDK query starts with.
