# Desktop App Guidance

## Style Guide

Use [../../docs/design/desktop-style-guide.md](../../docs/design/desktop-style-guide.md) as the visual source of truth for renderer UI work.

That guide defines:

- product tone
- typography
- color system
- shell composition
- sidebar and thread-row rules
- component constraints
- copy rules
- anti-patterns

## Non-Negotiables

- Inbox belongs above Recents and Directories.
- The sidebar is an information surface, not a stack of generic cards.
- Do not use browser-default controls in shipped UI.
- Do not ship implementation-status narration in user-facing copy.
- Keep radius at `8px` or below.
- Favor one accent color and neutral surfaces.

## Implementation Notes

- Centralize visual tokens before expanding renderer surfaces.
- Reuse shell primitives instead of adding one-off page styling.
- When in doubt, make the interface calmer, denser, and more editorial.
