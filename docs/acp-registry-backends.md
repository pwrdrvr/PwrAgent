# ACP Registry Backends

PwrAgent can consume allowlisted Agent Client Protocol (ACP) coding agents as
desktop backends. ACP is a client protocol for external coding-agent processes;
it is not raw model-provider access and it does not move PwrAgent's own Agent
Core behind ACP.

## What ACP Adds

- Registry discovery for ACP-compatible coding agents.
- Per-agent backend identities such as `acp:gemini`, alongside `codex` and
  `grok`.
- Profile-state install records that preserve distribution source, allowlist
  rule, verification state, auth state, and launch descriptor.
- ACP session metadata in the same navigation/thread model used by built-in
  backends.
- Client-owned mediation for ACP filesystem, terminal, and cancellation flows.

## Allowlist Policy

PwrAgent does not expose the public ACP registry wholesale. A registry entry is
installable only when a PwrAgent allowlist rule permits its registry id,
version, distribution kind, and package/archive source. GPL-family licenses are
blocked unless a future rule explicitly allows a specific entry.

The current launch allowlist lives in
`apps/desktop/src/main/acp/acp-agent-allowlist.ts`.

## Distribution Support

Supported launch forms:

- `npx` package descriptors.
- `uvx` package descriptors.
- Platform binary archives.

Package descriptors are stored as argument arrays and launched without shell
string interpolation. Binary installs use a staging directory before promotion.
Checksum/signature metadata is verified when present. If a binary source lacks
integrity metadata, it is installable only when the allowlist rule explicitly
permits that exact unverified source, and Settings surfaces that state.

## Trust Boundary

Default Access and Full Access map to ACP requests that PwrAgent owns, such as
filesystem writes and terminal creation requests sent through the ACP client
API. PwrAgent cannot sandbox internal behavior an external ACP process performs
outside those protocol requests. Treat installed ACP agents as third-party local
executables with their own credential, network, and subprocess behavior.

## Runtime State

ACP registry cache, installed-agent records, and ACP session metadata live in
the active PwrAgent profile sqlite database under `~/.pwragent/profiles/<name>/`.
Installed agents continue to be listed from profile state when the registry is
temporarily unavailable.

ACP session metadata does not include full transcript history. Providers that
support `session/load` remain the source of truth for restored ACP transcripts.
If PwrAgent later needs to persist fallback history for an ACP provider that
cannot restore its own sessions, use append-only JSONL rollout files rather
than sqlite; see [thread-history-persistence.md](thread-history-persistence.md).

## Rollout Notes

Ship with a narrow allowlist. Add new agents only after agent-specific smoke
testing covers install, launch, session creation, prompt turn, cancellation,
filesystem/terminal requests, auth/setup status, and registry-unavailable
startup.
