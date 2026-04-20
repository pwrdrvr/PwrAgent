---
title: "feat: Add Tangerine Terminal Visual System"
type: feat
status: completed
date: 2026-04-20
origin: docs/brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md
---

# feat: Add Tangerine Terminal Visual System

## Overview

Update the desktop renderer from the current charcoal/chartreuse palette to a black-first Tangerine Terminal visual system. The work should preserve the existing React/Electron architecture and CSS-variable styling model while making the full shell, navigation, transcript, and composer read as crisp black, warm white, neutral gray, and sparse tangerine signal.

## Problem Frame

The app currently has centralized styling, but the active palette reads too much like gray text on darker gray surfaces and uses chartreuse as the main accent. The origin requirements ask for a more Bloomberg-esque workstation feel without becoming flashy: absolute black canvas, white and gray reading text, and tangerine used only as a precise signal (see origin: `docs/brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md`).

## Requirements Trace

- R1. Adopt the Tangerine Terminal direction: black app canvas, near-black surfaces, warm white primary text, neutral gray secondary text, sparse tangerine accent.
- R2. Use tangerine as a precision signal for active/focus state, primary actions, important command labels, selected-state cues, structural emphasis, and live/running indicators.
- R3. Keep core reading surfaces white and gray on black for long-session comfort.
- R4. Avoid large orange panels, decorative gradients, novelty terminal effects, and rainbow status systems.
- R5. Cover the full shell: sidebar, thread rows, directory rows, header metadata, transcript cards/messages, composer, buttons, chips, badges, focus, hover, selected, loading/running, empty, and error states.
- R6. Update the desktop style guide so future renderer work follows Tangerine Terminal.
- R7. Preserve Inbox above Recents/Directories, thread-first hierarchy, compact density, and one primary accent color.
- R8. Eliminate low-contrast gray-on-gray in primary workflows.
- R9. Keep muted metadata readable in dense lists and transcript headers.
- R10. Make focus and active states immediately visible without relying only on background shifts.
- R11. Pair critical workflow state color with text, iconography, placement, or another non-color cue.
- R12. Continue using centralized semantic CSS tokens; no shadcn/Tailwind/Radix migration is required.
- R13. Token names should discourage one-off hard-coded black, gray, white, or tangerine values across renderer files.

## Scope Boundaries

- Do not migrate to shadcn, Tailwind, Radix Themes, or another component system.
- Do not redesign the information architecture or change navigation behavior.
- Do not add marketing-style ornamentation, decorative glow effects, large gradients, or multi-accent branding.
- Do not relax existing desktop constraints: compact density, radius of 8px or less, and thread-first hierarchy.
- Do not use green as a brand accent. Keep it only for functional success state if the final UI needs it.

## Context & Research

### Relevant Code and Patterns

- `apps/desktop/package.json` confirms the desktop app is React 19, Electron, Vite, Playwright, and Vitest with no Tailwind, shadcn, Radix, or component-library dependency.
- `apps/desktop/src/renderer/src/styles/app.css` is the visual source for renderer tokens, typography, shell layout, rows, transcript surfaces, context rail, and composer styling.
- `docs/design/desktop-style-guide.md` is the project source of truth for desktop UI direction and currently documents the chartreuse control-room palette that this plan replaces.
- `apps/desktop/AGENTS.md` requires renderer UI work to follow the desktop style guide, preserve Inbox above Recents and Directories, avoid browser-default controls, keep radius at 8px or below, and favor one accent.
- Navigation surfaces are split across `Sidebar.tsx`, `InboxList.tsx`, `RecentsList.tsx`, `DirectoriesList.tsx`, `ThreadMetaChips.tsx`, and `ThreadRowStatus.tsx`.
- Thread detail surfaces are split across `ThreadView.tsx`, `ThreadHeader.tsx`, `ThreadContextPanel.tsx`, `TranscriptList.tsx`, `TranscriptMessage.tsx`, `TranscriptPlan.tsx`, `TranscriptActivity.tsx`, `TranscriptDiff.tsx`, and `ThinkingScanner.tsx`.
- Composer surfaces live in `Composer.tsx` and `SkillChip.tsx`.
- Existing tests cover behavior and rendering in `src/renderer/src/__tests__/app-shell.test.tsx`, navigation tests, composer tests, transcript tests, and desktop Playwright specs under `apps/desktop/e2e/`.

### Institutional Learnings

- No `docs/solutions/` directory or critical-patterns file is present in this checkout, so there are no project-local solution notes to apply.

### External References

- shadcn/ui theming uses semantic CSS variables for background, foreground, primary, borders, and component states: https://ui.shadcn.com/docs/theming
- Tailwind CSS v4 exposes theme variables through CSS custom properties: https://tailwindcss.com/docs/theme
- Radix Themes and Radix Colors model color systems as scale-based tokens that can be consumed from CSS variables: https://www.radix-ui.com/themes/docs/theme/color and https://www.radix-ui.com/colors/docs/overview/usage
- WCAG contrast guidance: normal text should meet at least 4.5:1, large text 3:1, and non-text UI indicators generally 3:1 where applicable: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum and https://www.w3.org/WAI/WCAG21/understanding/non-text-contrast.html
- WCAG use-of-color guidance supports R11: color should not be the only visual means of conveying information or prompting a response: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color

## Key Technical Decisions

- Keep the current CSS-variable architecture: The repo already has centralized custom properties in `app.css`, and external design systems support the same tokenized direction without requiring a dependency migration.
- Expand tokens before polishing components: `app.css` currently mixes semantic variables with hard-coded chartreuse, green, red, and white alpha values, and references `--accent-bright` without defining it. The foundation should be tightened first so component work does not multiply one-off colors.
- Use a black-first baseline palette: Start from `#000000` app canvas, near-black structural surfaces `#050505`, `#0a0a0a`, and `#101010`, warm primary text `#f7f3eb`, secondary text `#b8b0a5`, muted text `#8c857a`, and tangerine `#ff8a1f`. These values clear AA contrast in the important text pairings checked during planning; implementation may tune within the same direction if screenshot and contrast checks reveal issues.
- Treat tangerine as a sparse semantic accent: Primary actions, selected outlines, focus rings, active lens state, important labels, and live/running cues may use tangerine. Default panel backgrounds, long-form message bodies, and most metadata should stay neutral.
- Preserve functional status colors as status-only tokens: Added/removed diff rows, danger/error, and optional success states should remain distinguishable, but they should not become brand accents or compete with tangerine.
- Add lightweight theme contract coverage instead of visual snapshot sprawl: Unit-level token/contrast assertions and a small E2E computed-style/screenshot check should guard the theme better than brittle full-page snapshots alone.

## Open Questions

### Resolved During Planning

- Exact palette baseline: Use the black-first/tangerine token baseline listed in Key Technical Decisions, with implementation allowed to tune values only to satisfy contrast and screenshot quality.
- Token-vs-component split: Begin with token expansion and hard-coded color cleanup, then target component classes where surface hierarchy or non-color state cues need explicit changes.
- Verification thresholds: Target at least 4.5:1 for normal text, 3:1 for non-text active/focus indicators, visible focus on interactive controls, and no critical state conveyed by color alone.

### Deferred to Implementation

- Final micro-adjustments to individual alpha values after seeing the app in Playwright screenshots. This depends on rendered density, not just static token math.
- Whether any current hard-coded status color should be promoted to a semantic token or left local to a single component. The implementer should decide based on actual reuse while avoiding broad token bloat.

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

| Layer | Purpose | Examples |
| --- | --- | --- |
| Foundation tokens | Own raw palette and contrast-safe text/surface relationships | app canvas, surface levels, primary/secondary/muted text, tangerine accent, danger/success status |
| Semantic tokens | Express UI intent without hard-coding colors in component rules | selected background, hover background, focus ring, accent soft fill, accent border, command label |
| Component rules | Apply semantic tokens to real surfaces and states | rows, buttons, chips, transcript messages, plan/status cards, composer, context rail |
| Verification | Keep the theme stable as later UI work lands | token contrast tests, non-color state tests, E2E computed style checks, screenshot review |

## Implementation Units

- [x] **Unit 1: Update Desktop Style Guide**

**Goal:** Replace the existing chartreuse control-room direction with the Tangerine Terminal design direction so future renderer work has the right source of truth.

**Requirements:** R1, R2, R3, R4, R6, R7, R11

**Dependencies:** Origin requirements document.

**Files:**
- Modify: `docs/design/desktop-style-guide.md`
- Reference: `docs/brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md`

**Approach:**
- Rewrite the Color System section around black canvas, near-black structural surfaces, warm white/neutral gray text, and sparse tangerine.
- Preserve existing non-negotiables: thread-first hierarchy, compact desktop density, no card-heavy dashboard look, radius at 8px or less, one accent color.
- Add explicit guidance that tangerine should be used as a precise signal, not as large fills or the default text color.
- Add accessibility guidance from the origin doc: critical workflow states need a non-color cue.

**Patterns to follow:**
- Existing structure and tone in `docs/design/desktop-style-guide.md`.
- `apps/desktop/AGENTS.md` as the renderer UI constraint source.

**Test scenarios:**
- Test expectation: none -- documentation-only change. Verification is review against the origin requirements.

**Verification:**
- The style guide no longer recommends chartreuse as the primary accent.
- The style guide clearly describes the new palette, accent discipline, state guidance, and unchanged desktop constraints.

- [x] **Unit 2: Establish Tangerine Theme Tokens**

**Goal:** Convert `app.css` from the current chartreuse token set into a stronger semantic token layer for black-first Tangerine Terminal styling.

**Requirements:** R1, R2, R3, R4, R8, R9, R10, R12, R13

**Dependencies:** Unit 1 for documented design direction.

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles/app.css`
- Create: `apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.ts`

**Approach:**
- Replace the root token set with a semantic palette that separates raw surface/text/accent/status roles from component usage.
- Define missing link/focus/accent variants such as the current undefined `--accent-bright` equivalent.
- Replace reusable hard-coded chartreuse values and white/black alpha values with semantic tokens where the value expresses shared intent.
- Keep status-specific values for danger, success, diff added/removed, and warning distinct from the tangerine brand accent.
- Avoid making every color a token. Promote only values that are reused or carry semantic meaning.

**Patterns to follow:**
- Existing `:root` CSS-variable pattern in `app.css`.
- Existing Vitest renderer test setup under `apps/desktop/src/renderer/src/**/__tests__`.

**Test scenarios:**
- Happy path: Parse the renderer CSS token block and assert required semantic tokens exist for app background, surface levels, text levels, accent, accent soft fill, accent border, focus, danger, success, and links.
- Happy path: Compute contrast for planned primary, secondary, muted, accent, and primary button text pairings and assert they meet the agreed thresholds.
- Edge case: Assert no unresolved `var(--...)` references exist for new theme-critical tokens such as link/accent variants.
- Regression: Assert the old chartreuse literal values are not present in the reusable theme-token area.

**Verification:**
- Renderer CSS has one coherent token foundation.
- Theme contract tests prove the token set is complete enough to support component work.

- [x] **Unit 3: Restyle Shell and Navigation States**

**Goal:** Make the sidebar, thread rows, directory rows, lens switch, chips, status markers, and context rail read as black-first, crisp, and stateful without depending on orange-heavy fills.

**Requirements:** R2, R3, R5, R7, R8, R9, R10, R11, R13

**Dependencies:** Unit 2 token foundation.

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles/app.css`
- Modify: `apps/desktop/src/renderer/src/features/navigation/ThreadRowStatus.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/navigation/InboxList.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/navigation/RecentsList.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/thread-detail/ThreadContextPanel.tsx`
- Test: `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx`

**Approach:**
- Apply the new tokens to sidebar canvas, selected rows, hover states, lens switch active state, count pills, chips, directory launchpad button, and context rail.
- Change selected/active row treatment to combine near-black background, tangerine border/rail/outline, and clear typography rather than a large colored fill.
- Ensure unread/thinking/running cues have shape, text, accessible names, or placement beyond color. The existing thinking scanner already has motion/shape; unread or needs-attention indicators should not be a silent color-only dot when they affect user action.
- Keep the existing Inbox, Recents, and Directories hierarchy intact.

**Patterns to follow:**
- Existing navigation component structure and `thread-row` class naming.
- Existing tests that query status markers via `data-thread-status`.

**Test scenarios:**
- Happy path: Rendering a thinking thread still exposes a non-color status marker and does not expose the unread marker.
- Happy path: Rendering an unread/inbox thread exposes a visible or accessible non-color cue in addition to any color treatment.
- Integration: Sidebar still renders Inbox above Browse, and Recents/Directories switching continues to work with the same accessible controls.
- Regression: Selected thread rows still expose `aria-pressed` and keep row title/time/chip content visible.

**Verification:**
- Sidebar and context rail visually match the black/tangerine system.
- Navigation state remains accessible and behaviorally unchanged.

- [x] **Unit 4: Restyle Transcript, Composer, and Work Surfaces**

**Goal:** Apply the visual system to the primary work area so transcript reading, pending approvals, plan progress, diff surfaces, composer controls, autocomplete, attachments, and empty/error states feel unified and readable.

**Requirements:** R2, R3, R4, R5, R8, R9, R10, R11, R13

**Dependencies:** Units 2 and 3.

**Files:**
- Modify: `apps/desktop/src/renderer/src/styles/app.css`
- Modify as needed: `apps/desktop/src/renderer/src/features/thread-detail/TranscriptPlan.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/thread-detail/ThinkingScanner.tsx`
- Modify as needed: `apps/desktop/src/renderer/src/features/composer/Composer.tsx`
- Test: `apps/desktop/src/renderer/src/features/thread-detail/__tests__/transcript-list.test.tsx`
- Test: `apps/desktop/src/renderer/src/features/thread-detail/__tests__/thread-view.test.tsx`
- Test: `apps/desktop/src/renderer/src/features/composer/__tests__/composer.test.tsx`

**Approach:**
- Restyle transcript message surfaces so assistant/user differentiation is clear but not orange-dominant. Use border, alignment, role labels, and subtle surface levels before color fill.
- Restyle pending approval as an important workflow state with text, placement, button hierarchy, and tangerine emphasis, not just an orange/green panel.
- Keep plan step status labels visible; color dots can remain secondary because the label text already carries the status.
- Update the thinking scanner to fit the new tangerine direction without becoming a decorative glow effect.
- Restyle composer inputs, controls, autocomplete, attachments, and buttons around the token system.
- Preserve all existing composer behavior, image attachment behavior, skill mention behavior, and transcript scroll behavior.

**Patterns to follow:**
- Existing split between `TranscriptList`, `TranscriptMessage`, `TranscriptPlan`, and `TranscriptActivity`.
- Existing composer test coverage for send, interrupt, skills, image paste, and launchpad controls.

**Test scenarios:**
- Happy path: Transcript list renders assistant, user, plan, activity, and pending status entries with their existing accessible roles/content intact.
- Happy path: Pending approval still exposes Approve, Decline, and Cancel turn actions and conveys that approval is needed through text.
- Integration: Composer still supports thread mode and launchpad mode after style changes.
- Regression: Skill autocomplete and pasted image attachment controls remain reachable by role/name and keep focus-visible styling.
- Regression: Plan steps still display both text and status labels for pending, in-progress, and completed states.

**Verification:**
- Primary work surfaces are readable on black and no longer rely on chartreuse panels for assistant/status emphasis.
- Existing transcript and composer behavior remains unchanged.

- [x] **Unit 5: Add Visual and Contrast Verification**

**Goal:** Add targeted verification so the new theme is guarded by tests and screenshot review instead of relying only on manual taste.

**Requirements:** R1, R2, R3, R5, R8, R9, R10, R11, R12, R13

**Dependencies:** Units 2 through 4.

**Files:**
- Create: `apps/desktop/e2e/tangerine-terminal-theme.spec.ts`
- Modify as needed: `apps/desktop/e2e/fixtures/README.md`
- Reuse fixtures under: `apps/desktop/e2e/fixtures/`
- Reuse helper: `apps/desktop/e2e/fixtures/electron-app.ts`
- Test: `apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.ts`

**Approach:**
- Add a Playwright E2E spec that launches the desktop app with focused existing replay fixtures rather than requiring one mega-fixture. Use fixtures such as `approval-pending`, `codex-todo-list` / `grok-todo-list`, `edited-changes-order`, and directory/navigation fixtures to cover approval, plan, activity, transcript, composer, and sidebar states.
- Assert computed styles for key surfaces use black/near-black backgrounds, warm light foregrounds, and tangerine only for intended accent states.
- Include screenshot capture or screenshot-on-failure guidance for desktop review, while avoiding brittle pixel-perfect snapshots as the primary assertion.
- Add checks for focus visibility on representative controls: new thread, lens switch, selected row, context rail button, composer input, primary send/approval button where available.
- Exercise both the wide desktop layout and the narrower layout covered by the existing `max-width: 1100px` media query so the theme does not only work in one shell geometry.
- Document how the visual verification spec should be used during future UI passes.

**Patterns to follow:**
- Existing Playwright specs in `apps/desktop/e2e/`.
- Existing fixture launch helper in `apps/desktop/e2e/fixtures/electron-app.ts`.

**Test scenarios:**
- Happy path: With a replay fixture loaded, the app shell exposes black/near-black computed backgrounds for app, sidebar, transcript panel, and composer.
- Happy path: Primary text and metadata computed colors satisfy the contrast thresholds against their actual rendered backgrounds.
- Happy path: Selected row, active lens, focus ring, and primary button use the tangerine accent token or its intended semantic variant.
- Edge case: The narrow desktop layout keeps transcript, context rail, and composer surfaces readable and non-overlapping after the palette change.
- Edge case: A workflow status such as pending approval or unread/thinking state exposes text, label, role, icon shape, or another non-color cue.
- Regression: No major shell surface computes to the old chartreuse accent as a background or dominant text color.

**Verification:**
- Unit and E2E checks cover token completeness, contrast, key computed styles, focus visibility, and non-color status cues.
- A reviewer can open the E2E screenshot artifacts and validate that the visual result matches Tangerine Terminal rather than chartreuse control-room.

## System-Wide Impact

- **Interaction graph:** This plan touches renderer styling and optional presentational/accessibility details only. It does not change app-server contracts, thread navigation state, transcript loading, composer submission, or directory launchpad behavior.
- **Error propagation:** Existing error rendering remains in place; only the visual treatment and token mapping should change.
- **State lifecycle risks:** Low functional risk, but visual state risk is meaningful: selected, active, running, approval-needed, error, and disabled states must remain distinguishable after the palette change.
- **API surface parity:** No backend or shared contract changes are expected. If any component prop changes become necessary for non-color status cues, keep them renderer-local unless a shared type already carries the needed status.
- **Integration coverage:** E2E verification should cover shell + sidebar + transcript + composer together because visual hierarchy problems appear at the composed-app level.
- **Unchanged invariants:** Inbox remains above Recents/Directories; Recents remains the default browsing lens; thread rows continue to carry metadata; composer controls continue to map to the same backend/execution options.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| Orange becomes too dominant and fatiguing | Keep tangerine to semantic accent roles and verify with composed screenshots, not isolated token checks. |
| Token cleanup turns into a broad CSS refactor | Promote only reused semantic values. Leave local one-off values alone unless they conflict with the new theme or old chartreuse palette. |
| Visual-only tests become brittle | Prefer contrast, computed-style, role/name, and focused screenshots over pixel-perfect snapshots. |
| Critical state loses clarity when chartreuse is removed | Add non-color cues and tests for unread/thinking/approval-needed states. |
| Existing dark surfaces collapse into one black sheet | Use a small set of near-black surface levels and separators to preserve structure without returning to gray-on-gray. |

## Documentation / Operational Notes

- Update the desktop style guide in the same change set as the renderer visual pass so future work does not reintroduce chartreuse.
- Note in the E2E fixture docs that the theme spec is a visual-system guard, not a full design-regression suite.
- No runtime config, migration, release flag, or backend rollout is needed.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md](../brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md)
- **Desktop app guidance:** [apps/desktop/AGENTS.md](../../apps/desktop/AGENTS.md)
- **Desktop style guide:** [docs/design/desktop-style-guide.md](../design/desktop-style-guide.md)
- **Renderer CSS:** [apps/desktop/src/renderer/src/styles/app.css](../../apps/desktop/src/renderer/src/styles/app.css)
- **shadcn/ui theming:** https://ui.shadcn.com/docs/theming
- **Tailwind CSS theme variables:** https://tailwindcss.com/docs/theme
- **Radix Themes color:** https://www.radix-ui.com/themes/docs/theme/color
- **Radix Colors usage:** https://www.radix-ui.com/colors/docs/overview/usage
- **WCAG contrast minimum:** https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum
- **WCAG non-text contrast:** https://www.w3.org/WAI/WCAG21/understanding/non-text-contrast.html
- **WCAG use of color:** https://www.w3.org/WAI/WCAG22/Understanding/use-of-color
