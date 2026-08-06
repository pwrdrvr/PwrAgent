---
date: 2026-08-05
topic: star-map-mission-control
---

# Star Map Mission-Control Surface Requirements

## Summary

PwrAgent gets a **Star Map**: a full-window mission-control surface that shows
the operator's whole federation as a star field — instance cards arranged
hub-and-spoke around the gateway, health-animated links between them, and
compact thread cards floating beneath each instance for exactly the threads
that need attention. Clicking a thread card opens the thread floating **over**
the map. A [+] button on each instance card opens an AI intake chat that
creates a thread on that instance from a natural-language request.

The guiding thesis, verbatim from the operator:

> "This is the antithesis of the 'every AI app has a left bar'"

The point is to get the user **out of the monster thread list** and into two
modes the thread list serves badly:

1. **"I have this project and I want to do something"** — pick the machine,
   pick (or describe) the project, go.
2. **"What do I need to review?"** — see, across every instance at once, only
   the threads that are unread, mid-turn, waiting on approval, or carrying an
   open PR / unpushed work.

## Entry Point

- A globe / mission-control button in the top bar, placed to the **left of the
  MSG messaging-status chip**:
  - macOS/Linux: the `.thread-header__chrome` cluster in `ThreadHeader.tsx`
    and `ThreadPlaceholderHeader`.
  - Windows: the `AppTitleBar.tsx` right cluster.
  - Follow the existing terminal-toggle button pattern that already lives in
    that cluster (same sizing, tokens, aria treatment).
- **Must work for non-federated instances.** A standalone instance sees a
  single central instance card on the star-field background with its own
  thread cards below it. The map is not a federation-only feature; federation
  makes it richer.

## The Map

- **Star-field background**: subtle, token-driven colors only (the repo's
  no-raw-color-literals rule applies), correct in both light and dark themes.
- **Topology**:
  - Non-federated: one central instance card.
  - Federated: instances arranged around the gateway (or around dual
    gateway/client hubs when an instance plays both roles), hub-and-spoke
    lines between them.
  - **Solid lines with a subtle flow animation** for active/healthy links;
    **dashed lines** for dead/disconnected links.
  - Topology and health come from the existing federation health surface /
    peer directory: federation-runtime `health()`, peer statuses, and sibling
    instances from the peer directory broadcast. No new health plumbing.
- **Instance cards** show:
  - The instance's display label (`instanceLabel` config, defaulting to
    hostname).
  - The instance's assigned celestial icon (see below).
  - Two actions: **(a)** open the full remote-viewer window for that instance
    (the existing `openFederationWindow` flow; for the local instance this
    focuses the main window), **(b)** a **[+]** button that opens the AI
    intake dialog targeting that instance.

## Thread Cards

- Below each instance float compact cards for that instance's threads
  **needing attention**: unread, turn-in-progress, waiting-on-approval, plus
  threads with an **open PR attached or unpushed changes** (treated like
  unread for selection purposes).
- A small filter control lets the user tune which attention categories show.
- Card content mirrors the thread-list rows, a smidge more compact:
  - Title.
  - Project chips **with their meaning icons** (worktree icon + project name
    like "PwrSnap"; local-directory icon + "PwrAgent") but **without** the
    literal "Local"/"Worktree" text labels.
  - PR chips.
  - Status / unread cookie.
  - Reuse the `ThreadRow` / `ThreadMetaChips` primitives — do not reinvent
    chips.
- **Draggable within a "cloud" radius** of their instance icon. Arrangements
  are **remembered and synced across all instances in the federation** — this
  is deliberate protocol work:
  - Persist per-map-arrangement state locally (overlay-store table suggested).
  - Sync via a new federation notification/RPC so every instance renders the
    same map.
  - Last-writer-wins semantics; tolerant of offline peers (peers converge when
    they reconnect; no coordination or locking).

## Celestial Instance Icons

- Five to start:
  1. A cratered moon.
  2. A Saturn-like ringed planet.
  3. A second ringed planet with a different silhouette (e.g. steep ring
     tilt).
  4. A shining sun.
  5. A Gargantua-style black hole — thin accretion ring crossing a dark
     sphere. The **shape** only; an original drawing, no copyrighted imagery.
- Spec:
  - Inline SVG React components.
  - Colored **only** via CSS tokens / `currentColor` + opacity; correct in
    both themes.
  - Crisp at three scales: ~16px chip (thread rows / Cmd+K results), ~48px
    instance card, and ~256px+ as an alpha-blended background watermark
    behind thread cards/transcripts (low opacity, must not fight text
    contrast — verified against the a11y axe gate).
- **Assignment**: auto-assigned uniquely across the federation. The gateway
  coordinates assignment; the mapping syncs the same way the map arrangement
  does. User-overridable in Settings → Federation.
- The icon is a **recognition device**: "oh, this is the moon — that's that
  machine." It appears on instance cards, on thread cards, and as the
  watermark background in thread viewers (the local viewer gets the local
  instance's icon).

## Floating Thread Window

- Clicking a thread card opens the thread floating **over** the map: rounded
  corners (respecting the ≤8px radius rule), not full-bleed — close to the
  edges, movable, with the star map shoved off to the left behind it.
- Reuse `ThreadView` with the per-thread federation target — the App shell
  already scopes IPC per selected thread's federation ref.

## AI Intake ([+] on each instance card)

- Opens a chat dialog that dispatches a natural-language request to an intake
  sub-agent **on that instance**: "give me a task, tell me the project, and
  any specifics that don't match your defaults."
- Example: "Make a PwrAgent thread to look into the issue I just took a
  screenshot of in PwrSnap."
- The intake agent:
  - Reads `~/.pwragent/AGENTS.md` for the user's thread-startup preferences.
  - Uses the existing dynamic tools/MCP surface to resolve the
    project/directory.
  - Creates the thread with the specified settings (federation `startThread`
    is already routed).
- The new card **"bubbles" into the map with an animation**. This is the
  showcase moment — make it feel awesome.

## Sequencing

The celestial icon system (components + assignment sync) is **shared with a
sibling feature** (Cmd+K unification / remote threads in the local thread
list). Build the icon components and the assignment protocol as an early
standalone unit so the sibling branch can consume them.

Natural PR split:

1. Celestial icon components + gateway-coordinated assignment sync (+
   Settings → Federation override).
2. Star Map surface: entry button, star field, topology/health rendering,
   instance cards, thread cards + filter, floating thread window.
3. Arrangement drag + persistence + federation sync.
4. AI intake dialog + intake sub-agent + bubble-in animation.

## Constraints

- Repo conventions throughout: no Prettier, ESLint-only, dependency boundary
  rules, theme tokens only (no raw color literals), plan-doc workflow.
- Renderer may import only `@pwragent/shared`; all federation/overlay-store
  access crosses the IPC bridge.
- The a11y axe gate must stay green, including with the low-opacity watermark
  behind transcript text.
