---
date: 2026-04-20
topic: desktop-tangerine-terminal-visual-system
---

# Desktop Tangerine Terminal Visual System

## Problem Frame

The desktop app currently has the right product ambition, but the active palette reads too much like gray text on darker gray surfaces with a loud chartreuse accent. The next visual pass should make PwrAgnt feel more distinctive, sharper, and more durable for all-day work: absolute black foundation, crisp white text, neutral gray metadata, and sparse tangerine signal.

The goal is not a flashy theme or a literal Bloomberg clone. The goal is a serious terminal-like workstation with enough visual point of view that a screenshot immediately feels like a product.

## Design System Context

The desktop renderer currently uses hand-authored React/Electron CSS with centralized CSS custom properties. No shadcn, Tailwind, or Radix component system is installed in the desktop package today.

Current industry systems point in the same general direction even when the libraries differ: semantic tokens for surfaces, foregrounds, borders, focus, accents, and component states. PwrAgnt should keep the lightweight CSS-variable approach for now and strengthen the token model before considering a component-system migration.

## Requirements

**Visual Direction**
- R1. The app must adopt a "Tangerine Terminal" direction: absolute black app canvas, near-black structural surfaces, warm white primary text, neutral gray secondary text, and sparse tangerine accent.
- R2. Tangerine must act as a precision signal, not the main reading color. It should be reserved for active/focus state, primary actions, important command labels, selected-state cues, thin structural emphasis, and live/running indicators.
- R3. Core reading surfaces must be primarily white and gray on black so long transcripts, thread lists, and composer text remain comfortable for extended use.
- R4. The interface must still feel restrained and operator-grade: no large orange panels, decorative gradients, novelty terminal effects, or rainbow status systems.

**System Coverage**
- R5. The visual pass must cover the full desktop shell, not only color tokens: sidebar hierarchy, thread rows, directory rows, header metadata, transcript cards/messages, composer, buttons, chips, badges, focus rings, hover states, selected states, loading/running states, and empty/error states.
- R6. The desktop style guide must be updated so future renderer work follows the Tangerine Terminal direction instead of the current chartreuse control-room palette.
- R7. The visual system must preserve existing product hierarchy: Inbox above Recents and Directories, thread-first navigation, compact desktop density, and one primary accent color.

**Contrast and Readability**
- R8. The redesign must eliminate low-contrast gray-on-gray presentation in primary workflows. Primary text, row titles, message text, labels, and button text must remain clearly legible on their surfaces.
- R9. Muted metadata may be lower contrast than primary text, but must remain readable in dense lists and transcript headers.
- R10. Focus and active states must be immediately visible without relying only on subtle background shifts.
- R11. Critical workflow states must not rely on color alone. When a status changes what the user should do next, the UI should pair color with text, iconography, placement, or another non-color cue.

**Theme Architecture**
- R12. The implementation should continue to use centralized semantic tokens as the foundation. A shadcn, Tailwind, or Radix migration is not required to deliver this visual direction.
- R13. Token names should make component intent clear enough that future UI work does not hard-code one-off black, gray, white, or tangerine values across renderer files.

## Success Criteria

- A full-app screenshot reads as black-first, crisp, and distinctive rather than charcoal-on-charcoal.
- The UI has enough visual identity to feel compelling in an interview/demo context without becoming flashy or fatiguing.
- Tangerine appears as a controlled signal; the app does not become orange-dominant.
- Thread rows, transcript content, and the composer remain comfortable to scan during long sessions.
- The style guide and renderer tokens tell the same visual story.

## Scope Boundaries

- Do not migrate to shadcn, Tailwind, Radix Themes, or another component library as part of this requirement unless planning finds a concrete implementation reason.
- Do not introduce multiple brand accents. Green may remain only as a functional success color if needed.
- Do not redesign the core information architecture in this pass.
- Do not add marketing-style ornamentation, decorative glow effects, or heavy gradients.
- Do not relax existing desktop constraints: compact density, radius of 8px or less, and thread-first hierarchy still apply.

## Key Decisions

- Tangerine Terminal: Chosen over the current chartreuse palette because it better matches the desired Bloomberg-esque, black-first workstation feel.
- Full visual system pass: Chosen over a token-only swap because changing only global colors risks preserving the same gray-on-gray hierarchy problems.
- Orange sparks: Chosen over high-orange terminal styling so the app can pop while staying usable all day.
- Keep CSS-variable theming: Chosen because the app already has centralized custom properties and external systems validate token-based theming as the durable pattern.

## Dependencies / Assumptions

- The desktop style guide remains the source of truth for renderer UI direction.
- The current renderer CSS token layer is the right starting point for this pass.
- Exact color values should be chosen during planning/implementation with contrast checks, not finalized in this brainstorm.

## Alternatives Considered

| Option | Outcome |
| --- | --- |
| High-orange terminal | Rejected because it would create stronger demo impact but higher eye-fatigue risk. |
| Color-token pass only | Rejected because it would be faster but likely preserve weak component hierarchy. |
| shadcn-style neutral system | Rejected as the primary direction because it would be less distinctive and does not address the desired product personality by itself. |

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R1-R4][Technical] What exact black, near-black, white, gray, and tangerine token values best balance contrast, warmth, and long-session comfort?
- [Affects R5][Technical] Which renderer components can be updated through tokens alone, and which need targeted component styling changes?
- [Affects R8-R11][Technical] Which contrast thresholds and screenshot checks should be part of verification?

## Next Steps

→ /prompts:ce-plan for structured implementation planning
