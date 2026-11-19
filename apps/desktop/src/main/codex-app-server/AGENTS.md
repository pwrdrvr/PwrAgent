# Codex App Server Adapter Guidance

- Protocol types come from `@pwrdrvr/codex-app-server-protocol`; add no
  desktop-local mirrors. Use the stable surface unless the client intentionally
  opts into `--experimental`, and alias Codex specifics only at this boundary.
- Never stop the app server while another turn runs on it.
- `unsubscribeIdleThreads` releases idle threads; sub-agent threads stay
  subscribed.
- After a Codex upgrade or a change of the selected Codex,
  `app-server-generation-pool.ts` starts a new generation, which must finish
  its handshake before it takes work; nothing waits for global idleness. A
  thread stays on a replaced generation only while process-bound work holds
  it, and a retired client never starts Codex again.

Before changing app-server lifecycle, generations, thread subscription or
release, or the protocol adapter, read
[codex-app-server.md](../../../docs/codex-app-server.md).
