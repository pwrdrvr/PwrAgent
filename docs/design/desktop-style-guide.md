# PwrAgent Desktop Style Guide

This guide defines the visual language for the PwrAgent desktop app. It exists to keep the product from drifting into generic Electron-dark-dashboard styling as more UI gets built.

For exact theme tokens, palette usage, and Tangerine Terminal visual rules, use [docs/UI-THEME.md](../UI-THEME.md).

## Product Tone

PwrAgent should feel like a serious operator tool:

- dense enough for real work
- calm enough to keep long sessions readable
- opinionated enough to look like a product, not a scaffold

The visual direction is:

- **editorial, not ornamental**
- **tool-like, not marketing-like**
- **compact, not cramped**
- **high-signal, not chrome-heavy**

## Core Principles

1. **Threads are the product**
   Navigation, hierarchy, emphasis, and empty states should reinforce that threads are the primary object. Directory views are a lens, not the center of gravity.

2. **Information before decoration**
   Use spacing, typography, and contrast before reaching for borders, shadows, gradients, or cards.

3. **Sidebar is an information surface**
   The left rail is not a stack of generic boxes. It should read like an active operating queue with sections, row states, metadata, and hierarchy.

4. **One accent color**
   Most of the interface should rely on neutral surfaces. Use one accent color to indicate action, focus, and active state. Do not spread multiple loud accents across the shell.

5. **Density with legibility**
   This is a desktop app, not a landing page. We want compact navigation and rich rows, but never at the cost of scanability.

## Visual Thesis

Use a **Tangerine Terminal** aesthetic:

- absolute black foundation
- near-black structural surfaces
- crisp warm-white primary text
- neutral gray metadata
- sparse tangerine signal
- crisp typography
- subtle separators
- minimal elevation
- state communicated by emphasis, badges, and row treatment rather than giant colored panels

Avoid the default “blue-black Electron app with random rounded panels” look, and avoid turning the product into an orange novelty terminal. The goal is a serious black-first workstation with a small amount of high-confidence signal.

## Typography

### Typeface System

Use at most two families:

- **Primary sans:** `Geist`, `IBM Plex Sans`, or `SF Pro` fallback stack
- **Utility mono:** `IBM Plex Mono` or `JetBrains Mono` for branch names, commit-ish text, paths, and machine state

Recommended default stack if custom fonts are not installed yet:

```css
font-family: "Geist", "IBM Plex Sans", "SF Pro Text", "Inter", system-ui, sans-serif;
```

Recommended mono stack:

```css
font-family: "IBM Plex Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace;
```

### Type Scale

Use a restrained desktop scale:

- App title / page title: `40px / 700`
- Section title: `24px / 650`
- Thread row primary text: `14px / 600`
- Body text: `14px / 400`
- Secondary metadata: `12px / 500`
- Labels / caps / tiny status: `11px / 600`

Rules:

- no viewport-scaled type
- no negative letter spacing
- no giant headings inside utility panels
- long lists should use smaller metadata, not smaller primary labels

## Color System

### Neutral Base

Start from absolute black and near-black neutrals, not saturated navy, slate, or charcoal-heavy gray-on-gray.

Suggested palette:

- `--bg-app: #000000`
- `--bg-sidebar: #050505`
- `--bg-panel: #0a0a0a`
- `--bg-panel-hover: #101010`
- `--bg-row-active: #120800`
- `--border-subtle: rgba(247, 243, 235, 0.1)`
- `--border-strong: rgba(247, 243, 235, 0.2)`
- `--text-primary: #f7f3eb`
- `--text-secondary: #b8b0a5`
- `--text-muted: #8c857a`

### Accent

Use one accent only. Recommended direction:

- **tangerine** for action, focus, selected state, important command labels, and live emphasis

Suggested accent tokens:

- `--accent: #ff8a1f`
- `--accent-strong: #ffa33d`
- `--accent-soft: rgba(255, 138, 31, 0.12)`
- `--accent-border: rgba(255, 138, 31, 0.42)`

Tangerine is a precision signal, not the main reading color. Use it for focus rings, primary action states, selected-row cues, important labels, and small live indicators. Do not use large orange panels, orange page backgrounds, or orange as the default body text color.

### Status Colors

Keep status colors muted and functional:

- info: desaturated blue
- warning: amber
- danger: red-orange
- success: muted green

Status colors should appear mostly in badges, dots, and subtle row indicators, not full-panel fills.

Critical workflow states should not rely on color alone. Pair status color with text, iconography, placement, shape, or another non-color cue when the state changes what the user should do next.

## Spacing and Rhythm

Use an 8px base rhythm:

- 4px for tight UI adjustments only
- 8px, 12px, 16px, 24px, 32px as the main scale

Desktop shell guidance:

- sidebar section padding: `16px`
- thread row vertical padding: `10-12px`
- page content padding: `24-32px`
- section gaps: `20-24px`

Rules:

- do not let the app breathe like a marketing site
- do not compress rows until metadata overlaps or wraps badly
- prefer consistent vertical rhythm over ad hoc nudging

## Shell Layout

### Overall Structure

The shell should feel like:

- a fixed left operating rail
- a primary work surface
- optional right-side secondary context later

The main shell should not look like stacked floating cards on a dark background.

### Sidebar

The sidebar is a structured queue. It should contain:

1. top-level global actions
2. Inbox / Recents / Directories thread lens switch
3. thread or project lists
4. utility footer items

Rules:

- Inbox is the leftmost thread lens and should show unread work
- section headers should be quiet, compact, and utility-first
- rows should carry metadata inline
- active row state should be obvious without being loud
- avoid separate card containers for every section unless the section is a true tool surface

### Main Content

The primary content area should not be an empty dark field with a floating panel dropped in it.

Rules:

- use a stronger content grid
- anchor page titles to a consistent top inset
- empty states should feel intentional, not absent
- inspector-style panels should align to a layout system, not random width blocks

## Component Rules

### Cards and Panels

Cards are allowed only when they genuinely frame a unit of interaction or context.

Allowed:

- inspector panel
- modal
- repeated thread row item if it is interactive
- grouped settings surface

Not allowed:

- wrapping every sidebar section in a generic bordered rectangle
- putting a card inside another card
- using cards as a substitute for layout

Radius:

- maximum `8px`

Shadows:

- minimal to none
- rely on contrast and border tone first

### Buttons

Buttons should feel integrated into the product, not browser-default.

Rules:

- no unstyled HTML default buttons in product UI
- compact height
- clear primary / secondary / ghost hierarchy
- strong focus ring
- one accent-driven primary action style

### Thread Rows

Thread rows are one of the most important components in the system.

Each row should be able to carry:

- thread title
- secondary context snippet
- linked directories
- state markers
- recency
- optional branch / PR information

Rules:

- title line must remain scannable
- metadata should wrap or truncate gracefully
- active/selected state should be visible through background + border + accent cue
- unread / blocked / running / ready-for-review states should be distinguishable at a glance

### Badges and Pills

Badges should be compact and information-dense.

Use for:

- mode (`Guarded`, `Full access`)
- runtime status (`Running`, `Blocked`, `Ready`)
- branch / PR counts

Rules:

- small radius
- subtle fills
- avoid rainbow badge collections
- no oversized marketing-style pills

## Motion

Motion should be subtle and structural:

- row hover easing
- panel/content fade on selection
- lens switch transition
- loading shimmer or pulse only where it helps orientation

Avoid:

- big springy motion
- theatrical page entrances
- decorative parallax or float effects

## Copy Rules

PwrAgent UI copy should sound like product UI, not demo narration.

Good:

- `Inbox`
- `Needs review`
- `2 linked repos`
- `Blocked on approval`
- `Running in worktree`

Bad:

- `Electron shell is wired`
- `The next units will fill in...`
- `Desktop bridge`
- explanatory scaffold text that talks about implementation progress

Never ship implementation narration in the UI.

## States and Empty States

Every core surface needs explicit states:

- default
- hover
- selected
- active/running
- blocked
- empty
- loading
- error

Empty states should:

- explain what belongs here
- provide one clear next action
- still feel visually designed

They should not read like placeholder dev text.

## Anti-Patterns

Avoid all of the following:

- browser-default buttons
- giant empty dark surfaces
- every section boxed in the same bordered card
- saturated blue-on-black default Electron look
- orange-dominant terminal cosplay
- heavy gradients
- purple accents
- oversized radii
- explanatory placeholder copy
- randomly mixed font styles
- panel-heavy layouts with no row hierarchy

## Implementation Guidance

When styling the app:

- centralize tokens in CSS variables before scaling the interface
- define typography, color, spacing, border, and focus tokens first
- build the sidebar row component early; many later surfaces will depend on it
- prefer reusable shell primitives over one-off page styling

Recommended early primitives:

- `AppShell`
- `SidebarSection`
- `ThreadRow`
- `StatusBadge`
- `Panel`
- `SegmentedControl`

## Design Acceptance Criteria

A UI pass is on track when:

- the app no longer looks like a scaffold
- the sidebar reads as a working queue, not two stacked boxes
- the main area has structure even in empty states
- the color system feels restrained and intentional
- typography does most of the hierarchy work
- a screenshot looks like a product with a point of view

## Near-Term Priority

Before building deeper product surfaces, the next design pass should establish:

1. shell tokens
2. sidebar section structure
3. thread row design
4. button and badge system
5. one intentional empty state for the main panel

That should become the visual foundation for Units 2 through 4.
