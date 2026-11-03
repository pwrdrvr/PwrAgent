# Codex App Server Adapter Guidance

The Codex App Server wire protocol types come from `@pwrdrvr/codex-app-server-protocol`. Do not add desktop-local protocol mirrors here.

Use the stable surface by default. Only pass `--experimental` when the desktop client intentionally opts into experimental App Server APIs during `initialize`.

The published types model the Codex wire protocol. Keep desktop-facing contracts in `@pwragent/shared` normalized to PwrAgent concepts, and do Codex-specific alias handling only at this adapter boundary.

## Stopping the App Server

A stopped stdio `codex app-server` sends no `turn/completed` for the turns it was running, so every client-side record of them (renderer, messaging, the usage ledger) is left showing a live turn. Never stop the process while another turn runs on it. `recoverInvalidPersistedResponseMessageIds` asks Codex under the lifecycle barrier (`thread/loaded/list`, then `thread/read` status) and waits on turn and status notifications, not a clock, until nothing is running. Per-thread unload (`thread/unsubscribe` → `thread/closed`) is not a substitute: Codex unloads an unsubscribed thread only after an idle delay, a fixed 30 minutes in 0.153.

## Releasing Idle Threads

Codex keeps a thread loaded, with its MCP servers running, while it is active or any connection is subscribed to it. `thread/start`, `thread/fork` and `thread/resume` subscribe this connection; only `thread/unsubscribe` ends that. Before `unsubscribeIdleThreads`, every thread a long-lived app server touched stayed loaded until the server stopped: after 25 hours, one server held about 570 MCP children and 1,700 pipes.

`unsubscribeIdleThreads` releases a thread after 10 minutes without a request or event, unless this client or the registry (`codexThreadNeedsLiveEvents`) tracks work for it, or Codex reports it active. Sub-agent threads stay subscribed. Every thread operation resumes its thread before acting, and an operation in flight when its thread unloads (released here, or `thread/closed`) replays its resume and settings before its next request, as it does after a restart.
