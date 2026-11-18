# Codex App Server Adapter Guidance

Moved verbatim from [apps/desktop/src/main/codex-app-server/AGENTS.md](../src/main/codex-app-server/AGENTS.md),
which keeps a summary and says when to read this document.

The Codex App Server wire protocol types come from `@pwrdrvr/codex-app-server-protocol`. Do not add desktop-local protocol mirrors here.

Use the stable surface by default. Only pass `--experimental` when the desktop client intentionally opts into experimental App Server APIs during `initialize`.

The published types model the Codex wire protocol. Keep desktop-facing contracts in `@pwragent/shared` normalized to PwrAgent concepts, and do Codex-specific alias handling only at this adapter boundary.

## Stopping the App Server

A stopped stdio `codex app-server` sends no `turn/completed` for the turns it was running, so every client-side record of them (renderer, messaging, the usage ledger) is left showing a live turn. Never stop the process while another turn runs on it. `recoverInvalidPersistedResponseMessageIds` asks Codex under the lifecycle barrier (`thread/loaded/list`, then `thread/read` status) and waits on turn and status notifications, not a clock, until nothing is running. Per-thread unload (`thread/unsubscribe` → `thread/closed`) is not a substitute: Codex unloads an unsubscribed thread only after an idle delay, a fixed 30 minutes in 0.153.

## Releasing Idle Threads

Codex keeps a thread loaded, with its MCP servers running, while it is active or any connection is subscribed to it. `thread/start`, `thread/fork` and `thread/resume` subscribe this connection; only `thread/unsubscribe` ends that. Before `unsubscribeIdleThreads`, every thread a long-lived app server touched stayed loaded until the server stopped: after 25 hours, one server held about 570 MCP children and 1,700 pipes.

`unsubscribeIdleThreads` releases a thread after 10 minutes without a request or event, unless this client or the registry (`codexThreadNeedsLiveEvents`) tracks work for it, or Codex reports it active. Sub-agent threads stay subscribed: Codex 0.153 idle unload removes the child from the thread manager used by the parent's `send_input` and `wait`; only `resume_agent` explicitly reloads it. Cache the sub-agent classification so later sweeps do not re-read it, and forget it on `thread/closed`, unsubscribe, or server reset. Every thread operation resumes its thread before acting, and an operation in flight when its thread unloads (released here, or `thread/closed`) replays its resume and settings before its next request, as it does after a restart.

## Replacing the App Server After an Upgrade

A package manager can replace Codex under a running app server. Homebrew repoints `/opt/homebrew/bin/codex` and deletes the old Caskroom version, companion helpers such as `codex-code-mode-host` included. The old process keeps running, but every helper it spawns from beside its deleted executable fails, so Code Mode fails closed. Keeping the process alive cannot bring the helpers back; only a new launch can.

`app-server-generation-pool.ts` wraps each runtime's client in generations. The transport records the launched file (`executable-identity.ts`); a check before new work and once a minute compares it with what the same command names now (`decideCodexInstallationChange`). A Settings selection change is not this path: it still closes the client at an idle boundary. On a change, a new generation must finish its handshake before it takes work; a failed start leaves the old one serving and retries with backoff.

New threads and every thread without process-bound work go to the current generation, which resumes them from their history. A thread stays on a replaced generation only while `threadDependsOnAppServer`, `codexThreadBoundToAppServer`, or a pool call in flight holds it. A reserved start or queued input is not process-bound. The replaced generation retires through `retireAppServerWhenIdle` once nothing it owns is busy by `codexThreadNeedsLiveEvents`, rechecked under the lifecycle barrier with Codex's own active list. A retired client never starts Codex again. Events for a thread come only from the generation that owns it; approval request IDs from later generations are prefixed `g<n>:`.
