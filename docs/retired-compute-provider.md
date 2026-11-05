# Retired Sandboxer integration

PwrAgent no longer offers the built-in Sandboxer provider (`builtin:sandboxer`).
The provider's hosted endpoint was `https://sandboxer.com/mcp`; its optional
local transport launched `/usr/local/bin/sbx`. Neither transport is registered
or started by this version. The setup tile, Settings controls, provider-specific
PR-close cleanup, and repository verification skill/script have been removed.
No replacement compute provider is installed or selected.

Unit tests, lint, typecheck and desktop builds use the existing local commands
and repository CI. Desktop E2E retains its local/CI routes and native platform
verification. Operating-system and Electron sandbox security is unchanged.

## Existing profiles and threads

The registry ignores retired `mcp_connections.sandboxer_*` settings. They cannot
recreate the built-in connection, including when enabled and selected for new
threads in an older profile. Existing thread selections of `builtin:sandboxer`
are inert because that identity no longer resolves to a connection. New-thread
defaults include only currently registered, eligible connections.

This change preserves profile TOML, credentials, thread metadata, and existing
`thread_sandboxes` bookkeeping records. It performs no provider API calls and
does not stop, delete, or change remote environments or data. Automatic cleanup
on PR close no longer runs. Old records do not prove the state of a remote
resource.

Operator-created remote and stdio connections remain under operator control,
including a custom connection named `sandboxer`: its name alone does not prove
which service it connects to. Unrelated MCP providers retain their settings.

## Installed app versus source checkout

A source checkout or draft PR does not change the running installed app. Until
an updated app is installed and restarted, its old built-in connection may
remain active in the current profile and selected on new threads, even when a
thread has no environment selected.

In that older app, open **Settings → Plugins → MCPs**, expand **Sandboxer**, and
turn off **Select for new threads** while the connection is still offered,
then turn off **Offer to threads**. The new-thread switch is disabled once the
offer is off. Disabling the offer withholds that connection profile-wide; it does not
delete credentials or remote data. Do this only in the intended profile. An
individual thread's **MCP access** switch can also deselect Sandboxer for that
thread, but does not change the profile's new-thread default.

`manage_mcp_connections` supports `list`, `create`, and `describe_thread`; it
cannot disable or remove a connection. Use those reads to check the current
profile's `builtin:sandboxer` entry and what a thread received. If the supported
Settings UI is unavailable, report that the installed app is still enabled;
do not edit live SQLite, global credentials, or unrelated providers. The old
profile scalars live in `~/.pwragent/profiles/<profile>/config.toml` under
`[mcp_connections]`. Their preservation in this version is intentional, not an
instruction to edit a running app's files.
