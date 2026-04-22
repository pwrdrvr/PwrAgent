# Live Agent Messages Capture Recipe

This is a contract fixture based on Codex session
`019db338-ec7d-7050-9079-f914956ca7b1`, where several assistant commentary
messages streamed during exploration before the final answer.

The checked-in `replay.fixture.json` is curated by hand from that session shape
instead of exported from a protocol capture. Refresh it if the desktop replay
runtime starts preserving a raw Codex app-server capture for this exact
multi-message turn lifecycle.

## Scenario Shape

1. Open the replay thread.
2. Start a turn asking to brainstorm Telegram support.
3. Replay two tool calls and three live assistant commentary messages.
4. Complete the turn with a final answer that is distinct from the commentary.

The UI must keep all assistant messages visible instead of replacing the latest
visible message as new stream item ids arrive.
