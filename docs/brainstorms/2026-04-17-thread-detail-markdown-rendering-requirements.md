---
date: 2026-04-17
topic: thread-detail-markdown-rendering
---

# Thread Detail Markdown Rendering

## Problem Frame

The desktop thread detail view currently handles markdown inconsistently. Transcript messages use a custom parser that misses standard markdown such as `**bold**`, while thread summaries are rendered as plain text with no markdown support at all. This creates visible correctness bugs, makes imported or model-generated content look broken, and leaves the app maintaining custom parsing logic that comparable chat products generally avoid.

This change should replace the custom thread-detail markdown path with `react-markdown` so transcript messages and thread summaries render markdown consistently. The first pass is intentionally narrow: fix thread detail correctness, adopt a maintained renderer, and avoid broad renderer standardization elsewhere in the desktop app.

## Requirements

**Renderer Standardization**
- R1. Thread detail transcript messages must render with `react-markdown` rather than the current custom parser.
- R2. Thread detail header summaries must render through the same markdown rendering path used for transcript messages.
- R3. The first pass must standardize only the thread detail transcript-message and thread-summary surfaces, not unrelated markdown-like surfaces elsewhere in the desktop app.

**Markdown Behavior**
- R4. The first pass must use `remark-gfm` with `react-markdown` so thread detail content supports GitHub-flavored markdown behavior, including standard emphasis such as `**bold**`.
- R5. Markdown rendering must behave consistently for historical transcript entries and newly loaded thread detail content on refresh.
- R6. Existing thread-detail affordances that are layered on top of message text, such as skill mention chips, must either keep working as they do today or be intentionally excluded from markdown rendering with a documented reason.

**HTML Trust and Safety**
- R7. Raw HTML in markdown may be accepted for thread detail content, but rendered output must be sanitized to a defined safe subset before it reaches the UI.
- R8. The sanitization policy must apply consistently to both transcript messages and thread summaries.
- R9. The first pass must not rely on trusting model or backend HTML wholesale.

**Product Quality**
- R10. Markdown rendering in thread detail must improve correctness without making the interface noisier or more visually heavy than the current desktop style direction.
- R11. The change must reduce maintenance burden versus the current custom parser instead of replacing it with another bespoke parsing layer around the new renderer.

## Success Criteria

- Imported or model-produced `**bold**` text renders correctly in thread summaries and transcript messages.
- Thread detail content uses one standard markdown path instead of the current split between custom parsing and plain text rendering.
- The chosen solution keeps HTML handling explicit and sanitized rather than implicitly trusted.
- The change stays narrowly scoped to thread detail and does not trigger unrelated renderer churn across the desktop app.

## Scope Boundaries

- This work does not standardize every markdown-like surface in the desktop app.
- This work does not require streaming-optimized markdown rendering beyond what thread detail already needs for its current scoped surfaces.
- This work does not introduce custom markdown syntax beyond what `react-markdown` and explicitly selected plugins support.
- This work does not permit unsanitized raw HTML rendering from model or backend output.

## Key Decisions

- Standard renderer over custom parser: thread detail should use `react-markdown` rather than a homegrown parser.
- Narrow first pass: only transcript messages and thread summaries are in scope.
- GFM baseline: thread detail should use `remark-gfm` rather than only CommonMark basics.
- Sanitized HTML, not trusted HTML: raw HTML support is acceptable only behind a sanitizer and a defined allowlist.
- Renderer consistency over local exceptions: summaries and transcript messages should not diverge in markdown behavior.

## Dependencies / Assumptions

- The desktop renderer can take on a small additional dependency footprint for a maintained markdown library and its selected plugins.
- The existing thread-detail styling can absorb standard markdown elements without a broader redesign.
- Skill mention rendering is either compatible with the new markdown path or can be cleanly preserved without reintroducing a bespoke parser as the main rendering strategy.

## Outstanding Questions

### Deferred to Planning
- [Affects R6][Technical] How should skill mention chip rendering compose with the standard markdown renderer so the product keeps current affordances without forking markdown behavior?
- [Affects R7][Technical] What exact HTML tags and attributes belong in the safe subset for thread detail content?
- [Affects R10][Technical] What typography and spacing overrides are needed so standard markdown output matches the desktop thread-detail style guide?

## Next Steps

-> `/prompts:ce-plan` for structured implementation planning
