# Star Map Interactions

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Star Map Interactions

- Interactive Star Map children must guard canvas pan, wheel, and keyboard
  handlers before shipping.
- The map publishes its on-screen state to the main process for the
  `read_star_map_view` Agent tool. Keep that snapshot in memory only and keep
  it built inside the publisher's throttle — it sits on the drag path, so the
  input it is given must not build collections either. Read
  [../../docs/star-map-manager.md](../../../docs/star-map-manager.md) before
  changing the snapshot shape, the manager thread's identity, or how its
  instructions are delivered.
- Agent commands to the map (`fly_star_map_to`,
  `highlight_star_map_threads`, `set_star_map_view`) arrive through
  `useStarMapCommands` and must be answered exactly once, even when the
  handler throws: main holds the Agent's tool call open until the map
  replies. Each answer carries its command's kind, and main drops one that
  does not match. No Agent command may move keyboard focus. An Agent's
  highlight is its own ring, never written into the operator's selection.
