# Boat remote compute

Boat ([boat.dev](https://boat.dev)) runs per-second Ubuntu VMs. PwrAgent
offers it as the built-in compute connection `builtin:boat`, beside
[Sandboxer](sandboxer-remote-compute.md). The agent and thread stay on this
computer; Boat supplies the machine.

## PwrAgent is the MCP server

Boat has a REST API (`https://boat.dev/api/v1`) and a CLI, and no MCP server
for sandbox control. PwrAgent therefore hosts one, in the main process, and
is the only holder of the Boat API key.

| Piece | File | Job |
| --- | --- | --- |
| `BoatApi` | `apps/desktop/src/main/mcp-connections/boat-api.ts` | The one place the key is attached to a request |
| `BoatTools` | `apps/desktop/src/main/mcp-connections/boat-tools.ts` | The tool list and every rule below |
| `BoatConnection` | `apps/desktop/src/main/mcp-connections/boat-connection.ts` | Key storage, account status, one MCP server per session |
| `BoatSignIn` | `apps/desktop/src/main/mcp-connections/boat-sign-in.ts` | Browser sign-in through Boat's CLI, in a throwaway home |

A session is an MCP SDK `Server` joined to the gateway's client by
`InMemoryTransport.createLinkedPair()`. From there Boat is an ordinary
gateway connection: thread selection, tool approval, tool search, and the
owner broker work as they do for any other. The SDK is loaded lazily through
`mcp-sdk.ts`, as for every owner-side use.

## Signing in

Boat has no OAuth for third-party apps. Its CLI has a browser sign-in and can
create scoped, expiring API keys, so `BoatSignIn`
(`apps/desktop/src/main/mcp-connections/boat-sign-in.ts`) drives the CLI:

1. `boat login --json` answers a `login_url` event: a URL on boat.dev, a short
   code, and an expiry. Settings shows the code with a Copy button first, and
   opens the URL only when the operator clicks Open Boat to sign in, so the
   code is on the clipboard before Boat's page asks for it.
2. `boat login --wait --json` returns once the operator has approved it.
3. `boat api-key create PwrAgent --actions <list> --ttl 90d --json` mints the
   key. It is read from the CLI's output into the encrypted store. The list is
   `BOAT_KEY_ACTIONS`: one action per kind of request the tools make. Boat's
   `full-sandbox` preset is not enough, because it leaves out create, resume,
   fork and delete. A pasted key needs the same actions.
4. `boat logout` revokes the session the CLI opened.

Every step runs with a throwaway directory as the CLI's home (`HOME`,
`XDG_CONFIG_HOME`, `APPDATA`), deleted when the attempt ends however it ends.
This matters because the CLI keeps its session token in a plain file
(`~/Library/Application Support/ascii/boat/config.json` on macOS, mode `600`):
that file exists only inside the throwaway home, between steps 2 and 4. The
operator's own CLI login is never read or changed.

Only a URL on Boat's own origin is opened. The key expires after 90 days;
Boat then refuses it and the row asks for sign-in again. Sign-in needs the
Boat CLI installed. Without it, Settings offers the key field alone.

A launchpad tile's button opens Settings at its own row through a
`connection:<id>` Plugins route (`features/settings/plugins-route.ts`).

## The key

- Sign-in stores the key it mints. The operator can instead paste one in
  Settings → Plugins. Either way main checks it with `GET /limits`, then
  stores it in the encrypted stdio secret vault under `BOAT_API_KEY`. A key
  Boat rejects is not stored; one that is only too narrow to read limits is.
- The key is never written to `config.toml`, returned over IPC, sent to a
  federation peer, placed in a tool result, or put in a sandbox.
- Requests go only to Boat's fixed API address and refuse redirects.
- Text shaped like a Boat key (`boat_…`, `box_…`) is removed from every tool
  result and error before it reaches an agent.
- Disconnect removes PwrAgent's copy. It does not revoke the key at Boat.
- A federation window cannot connect, change limits, or open Boat pages: the
  key belongs to the machine whose threads use it.

## Rules the tools hold

These are enforced in `BoatTools`, whatever arguments an agent sends, and are
stated as properties in `boat-tools.property.test.ts`.

- **No public ports.** `host_port` always sends `public: false` and fails if
  Boat answers with a public URL. No tool takes a visibility argument.
- **Own sandboxes only.** A thread reaches the sandboxes it created or
  forked, recorded in `thread_sandboxes`. Another thread's id is refused
  without asking Boat. A session with no thread (a Settings tool listing) can
  call nothing.
- **Credentials stay out.** While `boat_keep_credentials_out` is on (the
  default), create, resume, and fork send `noEnv: true`, so the account's
  GitHub token, secrets, and model keys never enter a sandbox.
- **Above a cap, the operator is asked.** A size above `boat_max_type` or an
  auto-stop above `boat_max_ttl_minutes` puts one question to the operator,
  naming each value and its limit. Approval covers that one request and
  changes no setting. Declined, or with nobody to ask (a caller that cannot
  show a prompt), the request is refused with the limit named. It is never
  clamped. No auto-stop is set further out than a week, approved or not.
- **Named snapshots are the operator's.** `save_snapshot` saves a thread's
  own sandbox under a name so later sandboxes start warm
  (`create_sandbox` with `fromSnapshot`). It always asks first, saying that
  the snapshot outlives the thread, whether it replaces one, and what Boat
  charges beyond the plan's included count. PwrAgent keeps no record of
  named snapshots and never deletes one: they are a project's start-up
  images, kept on purpose. `fromSnapshot` takes a snapshot name only, never
  a share code, which would start someone else's machine image.
- **Named fields only.** Each request is built from the fields a tool
  declares; unknown arguments never reach Boat.
- **A fork copies a finished snapshot.** While a stopped sandbox is `stopping`
  or `archiving`, Boat already reports `snapshotAvailable: true` and accepts
  a fork, but copies the snapshot before the one it is writing. `fork_sandbox`
  reads the source first, waits up to 90 seconds for it to finish saving, and
  otherwise refuses. Its result carries `forkedFrom`, the source's state when
  it was copied. Seen with a real account on 2026-11-20.

A fresh sandbox reports `idle`, not `ready`, and accepts commands in both
states; the tool instructions say so. Boat refuses to save a named snapshot
on a trial plan (`trial_saved_snapshots_not_allowed`); the tool passes that
on. `account_status` and `list_snapshots` report how many the plan includes.

The question reaches the operator as an MCP form elicitation from PwrAgent's
in-process Boat server, routed by the gateway to the one tool call that
caused it (`mcp-upstream-elicitation.ts`). It is an upstream form, not a
host tool approval, so no access mode or approval policy answers it.
- **Cleanup is narrow.** PwrAgent's own cleanup session can stop and delete a
  thread's sandboxes and nothing else.

## Settings

Scalars under `[mcp_connections]`:

| Key | Default | Meaning |
| --- | --- | --- |
| `boat_enabled` | `false` | Offer Boat to threads |
| `boat_select_for_new_threads` | `false` | New threads start with it selected |
| `boat_tool_approval` | `"approve"` | As for any connection |
| `boat_cleanup_on_pr_close` | `true` | Delete a thread's sandboxes once all its PRs merge or close |
| `boat_keep_credentials_out` | `true` | Send `noEnv` on create, resume, fork |
| `boat_default_type` / `boat_max_type` | `"small"` / `"large"` | `small`, `default`, `large`, `xlarge` |
| `boat_default_ttl_minutes` / `boat_max_ttl_minutes` | `60` / `480` | Auto-stop, up to Boat's 30 days |

An unrecognized value falls back to its default; a default above its cap is
lowered to the cap.

## PR cleanup

`SandboxerPrCleanupService` serves both compute connections. It asks
`isSandboxCleanupOnPrCloseEnabled(connectionId)` per connection and calls
`delete_sandbox` (or `stop_sandbox`) through a `pwragent-cleanup` session.
Creating, forking, and deleting write one `thread_sandboxes` row each, through
the store calls the `thread-sandbox-record-created` and
`thread-sandbox-cleanup-two` write budgets already measure.

## The thread's sandboxes in the MCP access panel

`ThreadBoatSandboxes` lists what a thread on this machine created, with state,
size and what Boat has billed so far, and offers Stop and a two-step Delete.
The window calls `listThreadBoatSandboxes` and `changeThreadBoatSandbox` on the
gateway service, which run `list_sandboxes`, `stop_sandbox` and
`delete_sandbox` through `BoatTools` with the thread's own scope. The window
therefore reaches exactly what the thread's agent reaches, and a sandbox id
from another thread is refused before Boat is asked. A thread with no recorded
sandboxes is answered without a request to Boat. A remote thread shows no
section: the key and the bill belong to its owner.

## Not built yet

`forward_port` (a localhost tunnel) and workspace push and pull.
