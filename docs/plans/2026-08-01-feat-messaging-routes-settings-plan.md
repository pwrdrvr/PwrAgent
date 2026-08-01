---
title: "feat: Manage messaging routes in Settings"
type: feat
date: 2026-08-01
---

# Manage messaging routes in Settings

## Summary

Make Settings the complete desktop control plane for persistent messaging
routing. Messaging commands remain contextual shortcuts, but operators can
inspect and manage every active binding and default Agent assignment without
visiting the originating messaging surface.

## Product Contract

Settings -> Messaging gains a Routes section with two inventories:

- Default Agents: scope, messaging surface, target Agent, update time, and
  controls to add, retarget, or clear an assignment.
- Active bindings: messaging surface, target PwrAgent thread, binding kind,
  update time, and an Unbind action using the existing runtime revoke path.

The add-default flow supports the existing provider-neutral scopes: profile,
provider, workspace, parent, and conversation. Platform-specific labels explain
the identifiers required by each scope. Known conversation titles are shown
when persisted; stable IDs remain visible as a fallback.

Eligible Agent choices use the same backend capability policy as messaging's
in-surface picker: Codex Agents and ACP Agents advertising HTTP MCP support.
Stale targets remain visible on existing rows so operators can repair or clear
them.

## Architecture

- Add renderer-safe route DTOs to `@pwragent/shared`; do not import messaging
  interface types into the renderer.
- Add explicit active-assignment and active-binding list operations to both
  JSON and SQLite messaging stores.
- Add messaging IPC for list, set, and clear. Setting and clearing defaults
  mutate the existing assignment records; binding removal delegates to the
  existing runtime revoke operation so provider-side retirement remains intact.
- Expose the IPC through preload and `DesktopApi`.
- Render the section inside the existing Messaging settings pane and subscribe
  to the messaging change event for refreshes.

## Verification

- [ ] JSON and SQLite stores list only active routes.
- [ ] Main IPC maps records, filters eligible Agents, and performs mutations.
- [ ] Renderer tests cover empty, populated, add, retarget, clear, and unbind
  states.
- [ ] Focused tests, typecheck, ESLint, SQL lint, and dependency boundaries pass.
- [ ] The Settings pane is inspected in a running desktop build at desktop and
  narrow widths.
