# Desktop App Guidance

## Style Guide

Use [../../docs/UI-THEME.md](../../docs/UI-THEME.md) as the visual theme source of truth for renderer UI work.

Use [../../docs/design/desktop-style-guide.md](../../docs/design/desktop-style-guide.md) for broader desktop layout, product tone, component behavior, and copy guidance.

The theme guide defines:

- theme thesis
- palette and token usage
- component theme rules
- interaction constraints
- visual anti-patterns

The desktop style guide defines:

- product tone
- typography
- shell composition
- sidebar and thread-row rules
- component constraints
- copy rules
- anti-patterns

## Non-Negotiables

- Inbox, Recents, and Directories live in one thread lens switch, with Inbox leftmost.
- Unread state uses the orange cookie marker, not punctuation badges.
- The sidebar is an information surface, not a stack of generic cards.
- Do not use browser-default controls in shipped UI.
- Do not ship implementation-status narration in user-facing copy.
- Keep radius at `8px` or below.
- Favor one accent color and neutral surfaces.

## Implementation Notes

- Centralize visual tokens in `styles/app.css` before expanding renderer surfaces.
- Reuse shell primitives instead of adding one-off page styling.
- When in doubt, make the interface calmer, denser, and more editorial.
- Use the project-local [desktop E2E fixture seeding skill](../../.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when capturing or refreshing replay-backed desktop E2E fixtures.
