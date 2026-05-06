---
title: Settings screens — align with PwrAgent v2 design
type: feat
status: completed
date: 2026-05-06
origin: docs/design/pwragent-v2/project/PwrAgnt v2.html  # design source bundle, with sibling settings.jsx + styles.css
---

# Settings screens — align with PwrAgent v2 design

## Overview

The Settings overlay's chrome (title-bar strip, left nav, masthead) already
matches the v2 design; that work shipped in
[2026-05-05-004-feat-settings-overlay-titlebar-plan.md](./2026-05-05-004-feat-settings-overlay-titlebar-plan.md).
**This plan is about the right pane** — the per-section content panes
(Applications, Worktrees, Messaging, Models, Experimental, About) — and the
shared visual primitives they compose with.

The v2 design defines a coherent vocabulary for those panes (eyebrow + 22px
title + helper paragraph header; `.pa-card` panel; 220-px label-column field
rows with a sub-line under each label; copper-tinted segmented-pill controls;
custom track-and-thumb switch; uniform path-row blocks). Our current panes
predate that vocabulary and use a looser, denser ad-hoc grid (`.settings-panel`
+ `.settings-row` 160-px label column, native `<input type="checkbox">`,
multi-line segmented buttons, separate `.settings-discovery` and
`.settings-application` row treatments). The visual contrast between
overlay chrome and panel body is now what makes Settings feel half-finished.

The plan converges the panes onto the design's shared primitives, adopts the
per-pane head pattern (eyebrow / title / help paragraph), and replaces a
handful of ad-hoc bits (native checkbox, dual row-class system, two flavors
of "row of details with chips and a Use button") with one canonical version.
Everything below the title-bar strip is fair game; the title-bar strip and
left nav are not.

## Problem Statement / Motivation

Three concrete asymmetries today between what we ship and the v2 design:

1. **No per-pane head.** The breadcrumb in the title-bar strip says
   `Settings › Messaging`, but inside the right pane the Messaging panel
   jumps straight into a `.settings-panel` titled "General" with no
   pane-level eyebrow, no 22-px section title, and no helper paragraph
   that frames what the pane is for. The design (`pa-settings__head` block
   in every panel — see `docs/design/pwragent-v2/project/settings.jsx:64-75,
   132-142, 193-205, 311-322, 422-432, 533-541`) opens every pane with a
   short editorial preamble. Without it the panes read as raw forms.

2. **Mixed primitives.** Today we have:
   - `.settings-row` (160-px label, control inline) — used by Messaging
     toggles, list fields, secrets.
   - `.settings-field` (same shape, slightly different naming) — used by
     Models codex selection, Experimental composer.
   - `.settings-segmented` (3-col grid, multi-line buttons) — used by
     tool-usage notifications and composer.
   - `.settings-discovery__row` (5-col grid: command + source + version +
     status + button) — used by Codex paths only.
   - `.settings-application` (3-col grid: icon + body + button) — used by
     Editor / Terminal only.
   - Native `<input type="checkbox">` — used everywhere we toggle.

   The design collapses this to four shared primitives — `.pa-field`,
   `.pa-seg`, `.pa-pathrow`, `.pa-switch` — with consistent typography,
   spacing, and accent-tint behavior. Re-using them once means every pane
   gets the same visual rhythm.

3. **The Composer picker is a list, not a segmented.** Today the
   Experimental panel renders the composer choice as a 4-button segmented
   control with a "Default" meta line beneath each label. The design
   (`docs/design/pwragent-v2/project/settings.jsx:481-512`,
   `styles.css:1228-1308`) renders it as a vertical list of card-style
   options each with a left-side custom radio bullet, a bold title with
   inline "Default" badge, and a multi-line sub paragraph explaining the
   tradeoff. The list form reads better with four options of varying
   length and is what we should ship.

## Proposed Solution

### Reference markup, not literal copy

The v2 design HTML/JSX bundle is **reference, not target to copy verbatim**
(per `docs/design/pwragent-v2/SOURCE.md` policy, restated in CLAUDE.md).
We adopt:
- The visual vocabulary (typography, spacing, accent tinting, radii)
- The per-pane head pattern
- The four shared primitives (head, card, field, segmented, switch, pathrow)
- The composer-options list form

We **do not** adopt:
- Class names from the design bundle (`pa-*`). Ours stay `settings-*` to
  match the rest of the renderer.
- The design's 10-px card radius. Project policy is 8 px or below
  (`apps/desktop/CLAUDE.md` non-negotiable). Cards use 8 px.
- The design's separate `--text-subtle` and `--warn` token families if we
  don't already have them — add only the minimum new tokens this plan
  uses.
- The design's "Connection test" block (`pa-testblock`) on Messaging /
  Models. It wires a runtime ping (Telegram `getMe`, Discord
  `/users/@me`, xAI `/v1/models`, `codex --version`) we don't have today.
  See "Scope Boundaries" — this is deliberately out of scope for this
  pass.

### Shared primitives — the contract

Add to `app.css` and to `SettingsLayout.tsx`:

```
SettingsPanelHead    = eyebrow ("EXPERIMENTAL") + h1 (22px / 700) + helper paragraph
SettingsCard         = .settings-panel (existing) + optional chip in header (status / "default")
SettingsField        = grid 220px | 1fr; left = label + sub line; right = control + help
SettingsSegmented    = inline-flex pill chiclets; .is-active = accent-soft + accent-border
SettingsSwitch       = button with 26x14 track + 10px thumb; "On"/"Off" word
SettingsPathRow      = full-width row: optional icon + path/title + chip(s) + Use/Selected
SettingsCompOption   = full-width radio card: bullet + bold title + Default badge + sub
SettingsAboutKv      = 2-col grid; uppercase 10px dt + 13px mono dd
```

`SettingsPanelHead` is new. `SettingsCard` is the existing `<SettingsSection>`
primitive (lightly extended with a chip slot). `SettingsField` replaces
both `.settings-field` and `.settings-row` callsites in panels (legacy
classes stay defined for transcript / questionnaire / mcp callsites that
also use `.settings-row`). `SettingsSegmented` restyles the existing
`.settings-segmented` selector — same class name, new visual contract.
`SettingsSwitch` is a brand-new primitive replacing every native
`<input type="checkbox">` in settings panels. `SettingsPathRow` is the
canonical row used by Codex discovery, Editor list, Terminal list. The
gh-status panel keeps its current pill-based status display
(`.settings-pill`) — already on-design.

### Per-pane changes

| Pane | Head copy (eyebrow / title / helper) | Notable structural changes |
|---|---|---|
| Applications | "Applications" / "Editor & terminal" / "Choose which apps PwrAgent opens when you click the editor or terminal launcher below the composer." | Editor + Terminal cards each render `SettingsPathRow` list. gh-status card retains `.settings-pill` row. |
| Worktrees | "Worktrees" / "Storage & cleanup" / "PwrAgent creates a fresh git worktree for every thread so concurrent agents don't collide on your working tree. Pick where those worktrees live." | Storage card uses one `SettingsField` with the segmented + a help line. Effective path moves to a second `SettingsField` with a read-only mono input. |
| Messaging | "Messaging" / "Connected chat platforms" / "Bridge PwrAgent threads to messaging platforms so you can drive runs from your phone. Tokens are stored in the system keychain." | General card (tool-usage segmented + input debounce). Telegram + Discord cards use `SettingsField` rows + `SettingsSwitch` for Enabled / Streaming. Bot-Token row keeps Replace / Clear buttons inline. |
| Models | "Models" / "Backends & credentials" / "PwrAgent drives Codex and Grok. Use Auto Discovery to track the newest binary on disk, or pin a specific path." | Codex card: segmented selection + `SettingsPathRow` list of detected paths. Grok card: API-key field with Replace / Clear inline. |
| Experimental | "Experimental" / "Experimental features" / "Opt-in features that may change shape or be removed without notice." | Composer card uses `SettingsCompOption` list. Diff-condensation card uses `SettingsSwitch` + a select / segmented for the model pin. |
| About | "About" / "PwrAgent" / "Thread-centric coding agent. Built by PwrDrvr LLC." | Body uses `SettingsAboutKv` 2-col grid (Version / Copyright / Website / Electron / Chromium / Node). "Check for updates" stays in head. |

### Tokens added (minimum)

Project tokens already cover most needs. Add only:

```css
--text-subtle: rgba(247, 243, 235, 0.42);  /* design has it; matches our existing scale */
--success-border: rgba(74, 148, 92, 0.32);  /* used on .settings-pill--ok and card chips */
--info-border: rgba(86, 137, 196, 0.28);    /* parity with --info-soft */
```

Everything else (`--accent-soft`, `--accent-border`, `--bg-panel-elevated`,
`--text-muted`, etc.) already exists. We **do not** need
`--bg-overlay`, `--warn` family, `--font-sans`, `--accent-deep`,
`--button-text-on-accent` for this plan; if a future plan adopts the
design's warn states or display font, it adds those then.

## Technical Approach

### Architecture

`SettingsScreen` keeps its existing two-column shape (`.settings-nav` |
`.settings-main`). Inside `.settings-main` the breadcrumb strip is
unchanged. The only thing that changes is what goes into
`.settings-content` — the rendered `SectionBody`. Each panel is rewritten
on top of the new shared primitives.

`SettingsLayout.tsx` grows three new exports — `SettingsPanelHead`,
`SettingsField`, `SettingsCompOption` — plus `SettingsSwitch` and
`SettingsPathRow` (the latter two get their own files in
`features/settings/` for clarity). Existing `SettingsSection` /
`SettingsRow` primitives stay; `SettingsSection` gains an optional
`chip` / `chipKind` prop. Existing legacy `.settings-row` callsites
outside of settings (transcript review, questionnaire, mcp) are
**not** touched.

### File scope

#### Files this plan WILL touch

| File | Edit |
|---|---|
| `apps/desktop/src/renderer/src/styles/app.css` | (a) Add the three tokens listed under "Tokens added". (b) Replace `.settings-segmented` rules (lines 2130–2182) with the design-aligned chip-pill style. (c) Replace `.settings-field` / `.settings-row` rules (lines 1980–2032) with a 220-px label-column grid + sub-line / help-line treatment. **Keep** the existing class names — only the rules change. (d) Add `.settings-head*`, `.settings-card__chip*`, `.settings-switch*`, `.settings-pathrow*`, `.settings-comp-opt*`, `.settings-aboutkv*` rules. (e) Tighten `.settings-panel` to align with the design's `.pa-card` (border-radius 8 px stays per project policy; head padding 14 px / 18 px; body padding 0 — fields handle their own padding). (f) Drop `.settings-discovery*` (lines 2191–2221) and `.settings-applications` / `.settings-application*` (lines 2223–2290) — replaced by `.settings-pathrow*`. |
| `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx` | Add `SettingsPanelHead({ eyebrow, title, help, action? })`. Add `SettingsField({ label, sub?, help?, control })`. Add `SettingsCompOption({ value, title, sub, isDefault, active, onSelect })`. Extend `SettingsSection` with optional `chip` / `chipKind`. Existing `SettingsRow` stays for backward compatibility (still used by transcript / mcp). |
| `apps/desktop/src/renderer/src/features/settings/SettingsSwitch.tsx` | New file. Custom button-with-track-and-thumb switch. Renders an `<button role="switch" aria-checked>` with track + thumb + "On" / "Off" word, draggable false. Replaces every `<input type="checkbox">` in settings panels. |
| `apps/desktop/src/renderer/src/features/settings/SettingsPathRow.tsx` | New file. Single-row layout: optional left icon slot, primary text (path or name) on top of optional secondary mono path, chip slot, optional `Selected` chip vs. `Use` button. Used by Codex discovery + Editor / Terminal lists. |
| `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx` | Wrap content in `SettingsPanelHead`. Restyle each MessagingGroup as a `SettingsSection` card with optional chip ("Configured" / "Not configured" — no live test). Replace `<input type="checkbox">` calls with `<SettingsSwitch>`. Keep field shapes (label + control), but render through `SettingsField` so spacing matches the design. Bot-token row keeps Replace / Clear inline; tighten to 30-px secondary buttons. |
| `apps/desktop/src/renderer/src/features/settings/ModelsSettings.tsx` | Wrap content in `SettingsPanelHead`. Codex card uses `SettingsField` for selection + Codex path. Detected paths list switches from `.settings-discovery__row` to `<SettingsPathRow>` rendered with a chip slot for `source` / `version` / `Using` / `Available`. Grok card: API-key field as `SettingsField` with Replace / Clear inline. |
| `apps/desktop/src/renderer/src/features/settings/ApplicationsSettings.tsx` | Wrap content in `SettingsPanelHead`. Editor + Terminal cards switch from `.settings-application` rows to `<SettingsPathRow>` rendered with the existing icon (`iconDataUrl` or fallback). gh-status card keeps `.settings-pill` row. |
| `apps/desktop/src/renderer/src/features/settings/WorktreesSettings.tsx` | Wrap content in `SettingsPanelHead`. Storage card uses `SettingsField` for the segmented + help line; effective path becomes a second `SettingsField` with mono read-only `<code>` (existing behavior preserved). |
| `apps/desktop/src/renderer/src/features/settings/ExperimentalSettings.tsx` | Wrap content in `SettingsPanelHead`. Composer card replaces the segmented control with a `<SettingsCompOption>` list (one option per row). Diff-condensation card uses `<SettingsSwitch>` for Enabled and `SettingsField` for the model pin. |
| `apps/desktop/src/renderer/src/features/settings/AboutSettings.tsx` | Wrap content in `SettingsPanelHead` (with the "Check for updates" button as `action`). Replace the inline `<dl>` rendering with `.settings-aboutkv` 2-col mono grid. |
| `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx` | Update the small handful of assertions that interact with `<input type="checkbox">` (look for `getByRole("checkbox")` calls — switch to `getByRole("switch")`). Add 1 contract test per primitive: head renders eyebrow + h1 + help; switch toggles `aria-checked`; comp-option list selects on click; pathrow shows "Use" by default and "Selected" chip when active. |
| `apps/desktop/src/renderer/src/features/settings/__tests__/messaging-settings.test.tsx` (if exists; otherwise inline in settings-screen.test.tsx) | Update interactions that drive the toggles. |
| `apps/desktop/e2e/composer-draft-settings.spec.ts` and adjacent E2E specs | If any spec asserts on a settings checkbox or `.settings-application` class, retarget to the new role / class. Most specs go through the title-bar strip + section nav and won't need updating. Run the full e2e suite to confirm. |

#### Files this plan WILL NOT touch (hard guard rails)

| File | Why locked |
|---|---|
| `apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx` | Title-bar strip + left nav + masthead just shipped. The shape (`<nav> + <main>`, breadcrumb, MessagingStatusBar in strip) is canonical. **No edits beyond importing new primitives** — and even those should land in pane files, not here. |
| `apps/desktop/src/renderer/src/styles/app.css` rules for `.app-shell__settings-layer`, `.settings-screen`, `.settings-nav*`, `.settings-titlebar*`, `.settings-main` (lines 1676–1935) | Title-bar / nav style is shipped and the user has stated those are "fine". This plan only touches the body / panel rules **below** that block. |
| `apps/desktop/src/renderer/src/App.tsx` | Settings still mounted as the same overlay; no body-grid changes. |
| `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx`, `ThreadHeader.tsx`, `ThreadView.tsx` | Main-screen chrome is **completely off-limits** for this plan. The user has stated this constraint multiple times, including during the prior settings-titlebar plan. |
| `apps/desktop/src/main/window.ts` | `titleBarStyle: "hiddenInset"`, stoplight position, drag region setup unchanged. |
| `apps/desktop/src/renderer/src/styles/app.css` rules for `.transcript-*`, `.thread-*`, `.sidebar*`, `.composer*`, `.app-shell*` | Restyling settings rows must not regress shared primitives used by transcript / questionnaire / mcp / composer surfaces. **Specifically:** `.settings-row` is used by `transcript-questionnaire__prompt` and `transcript-mcp__prompt` (and their variants). To avoid regressing those callsites, this plan **renames** the new settings field primitive to `.settings-field` (which is currently aliased to `.settings-row` in the rules — they share the grid). When the rule is split, `.settings-row` keeps the old grid shape (160-px label) for non-settings callsites; `.settings-field` gets the new design-aligned 220-px shape and is used inside settings panes only. |
| `packages/shared/src/contracts/desktop-settings.ts` and surrounding settings-snapshot types | Visual change only — the data shape is unchanged. |
| `apps/desktop/src/main/settings/*` (config writes, secret store, codex discovery) | Out of scope. |

### Implementation Units

#### U1. CSS primitives + tokens

**Goal:** Land the new visual vocabulary in `app.css` so individual panes can
adopt it without each pane defining its own one-off styles.

**Files:**
- update: `apps/desktop/src/renderer/src/styles/app.css` (token block at the
  top, settings rules at lines 1937–2346)

**Approach:**

1. Add the three new tokens (`--text-subtle`, `--success-border`,
   `--info-border`) to the `:root` block at the top of `app.css`.
2. Restyle `.settings-panel`: keep 8-px radius, drop the always-on
   `border-bottom` on `.settings-panel__header` to a conditional one (only
   render when there's body content beneath — handled in markup), and
   reduce header padding to `14px 18px`.
3. Add `.settings-card__chip` + variants (`is-ok`, `is-err`, `is-warn`,
   `is-default`) using accent / success / danger soft + border tokens.
4. **Split** the merged `.settings-field, .settings-row` rule. Keep
   `.settings-row` with the existing 160-px label grid for transcript /
   mcp / questionnaire callsites. Define `.settings-field` fresh with
   220-px label column, label + sub stack on left, control + help stack
   on right, `padding: 14px 18px`, top border separator (none on first
   child).
5. Add `.settings-field__sub` (12-px, muted), `.settings-field__help`
   (11.5-px, muted, optional `Info`-icon prefix).
6. Replace `.settings-segmented` rules with the design-aligned inline-flex
   chip style: `padding: 3px`, `border-radius: 8px`, `gap: 2px`,
   `background: var(--bg-panel-elevated)`, internal buttons
   `padding: 6px 12px` and `.is-active` becomes `background:
   var(--bg-row-active)` + `border-color: var(--accent-border)` +
   `color: var(--accent-bright)`. Drop the multi-line column flex on
   `.settings-segmented__button`. Remove `.settings-segmented__meta`
   (Default badge moves to its own primitive on comp-option).
7. Add `.settings-switch*` rules: outer `<button>` is inline-flex with
   gap-8 between track + word; track is 26×14 with 1-px border; thumb is
   10×10 absolute-positioned and animates `left` from 1 to 13;
   `.is-on` track gets `background: var(--accent-soft)`, thumb gets
   `background: var(--accent)`.
8. Add `.settings-pathrow*` rules: row 10 px / 12 px padding, 8-px radius,
   `border: 1px solid var(--border-subtle)`, `background:
   var(--bg-panel-elevated)`. `.is-selected` gets `border-color:
   var(--accent-border)` + `background: var(--bg-row-active)`. Inner
   slots: `__icon` (32×32), `__title` (13-px / 700), `__path` (12-px
   mono / muted, single-line ellipsis), `__chips` (inline-flex / gap 4).
9. Add `.settings-comp-opt*` rules: full-width button card, 12-px / 14-px
   padding, 8-px radius, left-aligned text, custom radio bullet (16-px
   ring + 8-px center dot), title row with optional `__defbadge`
   (uppercase 9-px), sub paragraph (12-px muted).
10. Add `.settings-aboutkv` 2-col grid, dt = uppercase 10-px muted,
    dd = 13-px mono primary, with a links treatment.
11. Drop `.settings-discovery*` (lines 2191–2221). Drop
    `.settings-applications`, `.settings-application*` (lines 2223–2290).
    These are replaced by `.settings-pathrow*`.

**Patterns to follow:**
- The existing `.settings-titlebar*` and `.settings-nav*` blocks just landed
  and use `var(--bg-panel-elevated)`, `var(--accent-bright)`,
  `var(--text-secondary)` consistently — match that token usage.
- `apps/desktop/src/renderer/src/styles/app.css:485-490` (`.eyebrow` rule)
  is the canonical eyebrow pattern; reuse it for the new
  `.settings-head__eyebrow`.

**Verification:**
- `pnpm test` settings-screen.test.tsx and its theme-contract tests pass
  (no missing tokens; `var(--text-subtle)`, `var(--success-border)`,
  `var(--info-border)` resolve).
- Visual inspection: open the dev app and switch through every pane —
  classes still apply, nothing visually broken even before pane TSX
  edits land (in U2–U7 the markup adopts the new primitives).

**Execution note:** characterization-first. Before changing
`.settings-row` or `.settings-segmented`, grep for callsites in
`apps/desktop/src/renderer/src/features/transcript/`,
`features/messaging-questionnaire/`, `features/mcp/`. List them in the
PR description so reviewers can verify the rename leaves them intact.

#### U2. Layout primitives in `SettingsLayout.tsx` + new files

**Goal:** Expose the new vocabulary as React primitives so each pane is a
straight composition.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx`
- new: `apps/desktop/src/renderer/src/features/settings/SettingsSwitch.tsx`
- new: `apps/desktop/src/renderer/src/features/settings/SettingsPathRow.tsx`

**Approach:**

```tsx
// SettingsLayout.tsx — new exports
export function SettingsPanelHead(props: {
  eyebrow: string;
  title: string;
  help?: ReactNode;
  action?: ReactNode;
}) { /* renders <header className="settings-head"> */ }

export function SettingsField(props: {
  label: string;
  sub?: ReactNode;
  help?: ReactNode;
  control: ReactNode;
}) { /* renders <div className="settings-field"> */ }

export function SettingsCompOption<TValue extends string>(props: {
  value: TValue;
  title: string;
  sub: string;
  isDefault?: boolean;
  active: boolean;
  disabled?: boolean;
  onSelect: (value: TValue) => void;
}) { /* renders <button role="radio" className="settings-comp-opt"> */ }

// SettingsSection gains: chip?: ReactNode, chipKind?: "ok" | "err" | "warn" | "default"
```

```tsx
// SettingsSwitch.tsx
export function SettingsSwitch(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;        // for aria-label
  onChange: (next: boolean) => void;
}) { /* renders <button type="button" role="switch" aria-checked> */ }
```

```tsx
// SettingsPathRow.tsx
export function SettingsPathRow(props: {
  icon?: ReactNode;
  title?: ReactNode;     // bold primary text (Editor name, candidate command)
  path?: string;         // mono secondary path
  chips?: Array<{ label: string; tone?: "ok" | "err" | "muted" }>;
  selected: boolean;
  selectedLabel?: string;  // defaults to "Selected"
  useLabel?: string;       // defaults to "Use"
  disabled?: boolean;
  onUse?: () => void;
}) { /* one canonical path-or-app row */ }
```

**Patterns to follow:**
- Existing `SettingsSection` / `SettingsRow` shapes
  (`SettingsLayout.tsx:14-79`) — match prop naming and accessibility
  treatment.
- `MessagingStatusBar` (already imported in `SettingsScreen.tsx`) is a
  good example of a self-contained UI primitive that hides itself when
  there's nothing to show.

**Verification:**
- New primitive tests in `__tests__/settings-screen.test.tsx`:
  - `SettingsSwitch` toggles `aria-checked` and fires `onChange`.
  - `SettingsCompOption` renders the radio bullet, "Default" badge when
    `isDefault`, and calls `onSelect` on click.
  - `SettingsPathRow` shows "Use" button when `selected={false}`,
    "Selected" chip when `selected={true}`, and respects `disabled`.
  - `SettingsPanelHead` renders eyebrow + h1 + help paragraph + action
    slot.

**Execution note:** test-first for `SettingsSwitch` and
`SettingsCompOption` — both replace native controls and we want a tight
spec for keyboard behavior (Space toggles switch; Up/Down navigates
comp-option list).

#### U3. Messaging panel adoption

**Goal:** Replace `<input type="checkbox">` and `.settings-row` markup
with the new primitives. Add `SettingsPanelHead`. Bot-token rows keep
Replace / Clear inline.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx`

**Approach:** Each `MessagingGroup` becomes a `<SettingsSection eyebrow="Messaging" title="Telegram" chip={configured ? "Configured" : "Not configured"} chipKind={configured ? "default" : ""}>`. The Field components inside (`ToggleField`, `SecretField`, `TextField`, `NumberField`, `ListField`, `SegmentedField`) are re-implemented on top of `SettingsField` + `SettingsSwitch`. Header for the whole pane: `<SettingsPanelHead eyebrow="Messaging" title="Connected chat platforms" help="Bridge PwrAgent threads to messaging platforms…">`.

**Patterns to follow:**
- The current `formatSourceLabel` / `sourceBadge` helpers (`features/settings/settings-fields.ts`) — keep using them for the env-override `.settings-source` pill.
- The runtime-disabled banner above MessagingGroup — keep it; just restyle to use the existing `.settings-panel--warning` (or a new `.settings-banner` if it doesn't fit).

**Verification:**
- All existing messaging-settings tests pass (after switching `getByRole("checkbox")` → `getByRole("switch")` where applicable).
- Manual: Telegram + Discord cards render with eyebrow / title / chip; Enabled and Streaming Responses are pill switches; Bot Token row keeps Replace / Clear inline.

#### U4. Models panel adoption

**Goal:** Codex card with segmented + path-list. Grok card with API-key field.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/ModelsSettings.tsx`

**Approach:**

- `SettingsPanelHead` for the pane.
- Codex card: `<SettingsSection eyebrow="Models" title="Codex" chip={sourceBadge(codex.path) || "auto"}>`. Inside: `<SettingsField label="Codex selection" sub={selectedLabel} control={<SettingsSegmented>}>`. When `mode === "specified" || envForced`: `<SettingsField label="Codex path" control={<input className="settings-input">}>`. Path list: replace `.settings-discovery` with `.settings-paths` containing one `<SettingsPathRow>` per `autoCandidates` entry. Chip slot shows the `source` (badge), `version` (mono), `Using` / `Available` chip.
- Grok card: `<SettingsSection eyebrow="Models" title="Grok" chip={grok.configured ? "Set · keychain" : "Not set"}>`. Inside: `<SettingsField label="API Key" control={<settings-secret row with Replace / Clear>}>`.

**Verification:**
- `pnpm test` ModelsSettings tests pass.
- Manual: Codex segmented switches modes; pathrow shows "Use" button next to non-active candidates and "Using" chip on the selected one.

#### U5. Applications panel adoption

**Goal:** Editor + Terminal cards each render a `<SettingsPathRow>` list.
gh-status card keeps existing pill row.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/ApplicationsSettings.tsx`

**Approach:**

- `SettingsPanelHead` for the pane (eyebrow "Applications", title
  "Editor & terminal").
- Each `ApplicationPanel` becomes a `<SettingsSection>` whose body is a
  `<SettingsPaths>` list containing one `<SettingsPathRow>` per
  candidate. Pass `icon={iconDataUrl ? <img /> : <fallback />}`,
  `title={application.name}`, `path={location}`,
  `chips={[{ label: source, tone: "muted" }, ...(canOpenWorkspace ? [{ label: "openable", tone: "muted" }] : [])]}`,
  `selected={...}`, `onUse={...}`.
- gh-status card stays largely intact — just wrap its content in the new
  panel structure (eyebrow + title) and keep `.settings-pill`.

**Verification:**
- `pnpm test` for any existing applications-settings tests.
- Manual: pathrow shows the icon + name + mono path on one row, with
  "Selected" chip for the active app and "Use" button for others.

#### U6. Worktrees panel adoption

**Goal:** Storage card uses `SettingsField` rows.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/WorktreesSettings.tsx`

**Approach:** `SettingsPanelHead` (eyebrow "Worktrees", title
"Storage & cleanup"). Storage card: one `<SettingsField label="Where should worktrees live?" sub={activeOption.description} help={overridden ? "Overridden by PWRAGENT_WORKTREE_STORAGE…" : undefined} control={<SettingsSegmented>}>`. Effective path: `<SettingsField label="Effective path" control={<code className="settings-input">}>`.

**Verification:**
- Existing WorktreesSettings tests pass.
- Manual: segmented + effective path read correctly.

#### U7. Experimental panel adoption

**Goal:** Composer picker becomes a `<SettingsCompOption>` list.
Diff-condensation card uses `<SettingsSwitch>` and `<SettingsField>`.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/ExperimentalSettings.tsx`

**Approach:**

- `SettingsPanelHead` (eyebrow "Experimental", title "Experimental features").
- Composer card: replace the segmented control with
  `COMPOSER_OPTIONS.map((option) => <SettingsCompOption value={option.value} title={option.label} sub={option.subText} isDefault={option.default} active={composer.value === option.value} onSelect={onComposerChange}>)`.
  Add a `subText` to each `COMPOSER_OPTIONS` entry — we have only the
  4-line copy from the design's `settings.jsx:395-420` to draw from;
  rewrite to PwrAgent voice (concise; no marketing).
- Diff-condensation card: `<SettingsField label="Enable diff condensation" sub="Send focused-diff hunks to xAI…" control={<SettingsSwitch>}>`. Below: `<SettingsField label="Eliding model" help={…} control={<SettingsSegmented>}>` where the segmented options are `auto`, `grok-4-fast-reasoning`, `grok-4-fast`, `grok-3-mini`, `grok-3`. Drops the native `<select>` we ship today.

**Verification:**
- Existing tests pass.
- Manual: clicking a comp-option highlights it; "Default" badge renders
  on the canonical option; switch toggles diff-condensation; segmented
  selects the model.

#### U8. About panel adoption

**Goal:** Two-column kv grid for build metadata.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/AboutSettings.tsx`

**Approach:** `<SettingsPanelHead eyebrow="About" title={metadata.applicationName} help="Thread-centric coding agent. Built by PwrDrvr LLC." action={<button>Check for updates</button>}>`. Body: `<dl className="settings-aboutkv">` with `<div><dt>Version</dt><dd>{metadata.applicationVersion}</dd></div>` rows. Update-result block (`UpdateResultStatus`) stays — drop into `<p className="settings-empty">` underneath the kv grid.

**Verification:**
- Existing AboutSettings tests pass.
- Manual: Version / Copyright / Website / Electron / Chromium / Node lay
  out as a 2-col grid with mono values; "Check for updates" button sits
  in the head action slot.

#### U9. Test + E2E sweep

**Goal:** Lock the contract; catch fallout.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx` (and any `*-settings.test.tsx` if they exist)
- maybe: `apps/desktop/e2e/composer-draft-settings.spec.ts` and adjacent E2E specs (only if a spec asserts on `<input type="checkbox">` or `.settings-application` class)

**Approach:**

- Run `pnpm test packages/agent-core packages/shared` and
  `pnpm --filter @pwragent/desktop test` (renderer Vitest).
- Run `pnpm test:desktop-e2e` (full Playwright suite). Identify any spec
  that retargets to switch / pathrow.
- Add per-primitive contract tests as listed under U2.

**Verification:**
- All test suites green.
- No `getByRole("checkbox")` left in settings-related specs.

## System-Wide Impact

- **Interaction graph.** Settings panes call `props.settings.writeConfig(...)` on save. Restyling does not change the call paths, the snapshot shape, or the IPC bridge — only what renders on screen.
- **Error propagation.** Toggle / segmented / comp-option errors surface through the same `props.saving` / `props.settings.error` props they do today. New primitives must respect `disabled` (env override; saving in flight) the same way native controls do.
- **State lifecycle risks.** None added — no persistence changes.
- **API surface parity.** N/A. The settings snapshot contract is unchanged.
- **Integration test scenarios.**
  - E2E: open Settings via the gear icon, switch to Messaging, toggle Telegram Enabled (now a `role="switch"`), confirm the writeConfig call fires.
  - E2E: open Settings → Models, click "Use" on a Codex pathrow that's not currently selected, confirm the path saves.
  - Renderer unit: render `ExperimentalSettings`, click each comp-option, confirm `onComposerChange` fires with the right value and the bullet flips.
  - Renderer unit: render `MessagingSettings` with `runtime.messaging.disabled = true`, confirm the disabled banner renders and switches are still disabled (saving=false but env override).

## Acceptance Criteria

- [ ] Every settings pane opens with a head (eyebrow + 22-px title + helper paragraph).
- [ ] Every settings card uses the same border / radius / header / chip style.
- [ ] Native checkbox toggles are gone from the settings panes; replaced by `SettingsSwitch`.
- [ ] Codex discovery and Editor / Terminal lists share the same `SettingsPathRow` visual.
- [ ] Composer picker is a vertical list of options with custom radio bullets, bold titles, and a sub line per option (not a segmented).
- [ ] Diff-condensation model is a segmented (not a native `<select>`).
- [ ] About panel uses a 2-col kv grid with mono values.
- [ ] Every interactive control in settings remains keyboard-accessible (Space toggles switch; arrow keys navigate radio groups; Tab reaches every actionable element).
- [ ] No regression on transcript / questionnaire / mcp surfaces (which share `.settings-row`).
- [ ] No visual change to the Settings title-bar strip, left nav, or main-screen chrome.
- [ ] All existing renderer + e2e tests pass without removing assertions.
- [ ] The plan's three new tokens (`--text-subtle`, `--success-border`, `--info-border`) resolve in the theme-contract test.

## Scope Boundaries

- **Does not** add a "Connection test" block on Messaging / Models. The
  design includes one (`pa-testblock`) but wiring it requires runtime
  ping calls (`getMe`, `/users/@me`, `/v1/models`, `codex --version`)
  that are out of scope here. Card chips in this plan show
  configured-vs-not, not live status.
- **Does not** add the design's "Auto-cleanup" worktree archive card —
  no archive policy ships today.
- **Does not** add Slack messaging or any new platform.
- **Does not** restyle the Settings title-bar strip, left nav, or
  masthead. Those just shipped and the user has stated they're fine.
- **Does not** restyle the main-screen chrome (Sidebar, ThreadHeader,
  ThreadView, composer). Hard guard rail; the user has stated this
  multiple times.
- **Does not** introduce a separate `--font-sans` or display-font token
  family. We compose with the existing `--font-mono` and the system
  default sans stack.
- **Does not** raise card radius to 10 px (design value). Project
  policy is 8 px; we keep 8 px.
- **Does not** add the design's `--warn` token family. If a future plan
  adopts warn states, it adds those tokens then.

## Key Decisions

- **Reference-not-target.** The v2 design HTML / JSX is a visual contract
  to converge on, not a literal markup to copy. We keep our class names
  (`settings-*`), our tokens, our radii.
- **Split `.settings-field` from `.settings-row`.** Renaming the new
  field primitive avoids regressing transcript / questionnaire / mcp
  surfaces that depend on the old grid shape.
- **Custom switch beats native checkbox.** The design's track-and-thumb
  switch reads better, has clear "On" / "Off" wording, and matches the
  rest of the calm-and-deliberate visual register. Worth the extra ~50
  lines of CSS + a tiny primitive.
- **Composer picker is a list, not a segmented.** Four options of
  varying length, each with explanatory sub copy, do not fit a
  segmented control.
- **Defer connection-test block.** Adopting the visual without the
  runtime would ship a button that does nothing. Better to wait until
  the bridges actually surface a "ping" call.
- **`.settings-row` stays for non-settings callsites.** Transcript /
  questionnaire / mcp lean on the existing 160-px grid; renaming the
  new primitive sidesteps a cross-feature visual regression.

## Dependencies / Assumptions

- The shipped Settings title-bar / nav primitives (PR #196) stay green
  and unchanged.
- `MessagingStatusBar` continues to render in the title-bar strip; this
  plan does not move it.
- Existing settings-snapshot fields (configured / overriddenByEnv /
  source / writable) cover what the chip slot needs; no new IPC.
- Playwright e2e fixtures keep targeting the section nav by role
  (`getByRole("navigation", { name: "Settings sections" })`); they do
  not lock against `<input type="checkbox">`.

## Outstanding Questions

### Resolve Before Planning

(none — questions below are intentionally deferred to implementation)

### Deferred to Implementation

- Exact copy for each `SettingsPanelHead`. The proposed phrasing in
  this plan is a starting point — refine during U3–U8 to match
  PwrAgent voice (terse, calm, editorial; never marketing).
- Should Telegram / Discord card chips show "Configured" / "Not
  configured" only, or also "Override (env)" when the bot token comes
  from the environment? Decide during U3 by inspecting the snapshot
  fields available.
- Whether to keep `SettingsRow` exported at all after panes adopt
  `SettingsField`. If no settings callsite needs it post-adoption,
  we can leave it for transcript / mcp consumers and drop the export
  from the settings barrel. Decide during U9.
- The diff-condensation segmented might overflow at 5 model options on
  narrow widths. If it does, fall back to a segmented in two rows or
  drop to the legacy `<select>`. Decide during U7.
- Whether `SettingsPathRow` should support a "default chip" tone for
  things like `application` / `path` source labels (no accent), vs.
  just two tones (muted / ok). Decide while writing the primitive.

## Sources & References

### Origin

- **Design source bundle:** [docs/design/pwragent-v2/project/PwrAgnt v2.html](../design/pwragent-v2/project/PwrAgnt%20v2.html). Full per-section reference markup at `settings.jsx`; tokenized rules at `styles.css`. Carry-forward from v2 design: per-pane head, four shared primitives (head + card + field + segmented + switch + pathrow), composer-options list form. Explicitly **rejected** from the design for this plan: 10-px card radius (project policy is 8 px), `--warn` family (unused here), `pa-testblock` connection test (no runtime backing).
- **Settings overlay title-bar plan (predecessor, completed):** [docs/plans/2026-05-05-004-feat-settings-overlay-titlebar-plan.md](./2026-05-05-004-feat-settings-overlay-titlebar-plan.md). Carries forward: scope discipline ("hard guard rails"), the title-bar / left-nav primitives that are now off-limits, the user's explicit constraint that main-screen chrome must not change.
- **Settings + config requirements brainstorm:** [docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md](../brainstorms/2026-04-30-desktop-settings-config-requirements.md). Carries forward: settings-section catalog (Applications / Worktrees / Messaging / Models / Experimental / About), R11 "follow `docs/UI-THEME.md` and `docs/design/desktop-style-guide.md`", R12 visual states (loading, save-in-progress, saved, validation/error, unavailable keychain).

### Internal References

- Current settings panes:
  - `apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx`
  - `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx`
  - `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx`
  - `apps/desktop/src/renderer/src/features/settings/ModelsSettings.tsx`
  - `apps/desktop/src/renderer/src/features/settings/ApplicationsSettings.tsx`
  - `apps/desktop/src/renderer/src/features/settings/WorktreesSettings.tsx`
  - `apps/desktop/src/renderer/src/features/settings/ExperimentalSettings.tsx`
  - `apps/desktop/src/renderer/src/features/settings/AboutSettings.tsx`
- Settings CSS today: `apps/desktop/src/renderer/src/styles/app.css:1937-2346`
- Title-bar / nav CSS (off-limits): `apps/desktop/src/renderer/src/styles/app.css:1676-1935`
- Tokens: `apps/desktop/src/renderer/src/styles/app.css:1-50`

### Design References

- v2 design reference markup: `docs/design/pwragent-v2/project/settings.jsx:60-606`
- v2 design styles: `docs/design/pwragent-v2/project/styles.css:1163-1469`
- v2 design tokens: `docs/design/pwragent-v2/project/lib/colors_and_type.css`
- Design provenance + "reference not copy verbatim" policy: [docs/design/pwragent-v2/SOURCE.md](../design/pwragent-v2/SOURCE.md)
- Project visual contract: [docs/UI-THEME.md](../UI-THEME.md), [docs/design/desktop-style-guide.md](../design/desktop-style-guide.md)
- Project non-negotiables (radius ≤ 8 px, calm visual register): [apps/desktop/CLAUDE.md](../../apps/desktop/CLAUDE.md)

### Related Work

- PR #196 (predecessor — title-bar / nav scaffolding): merged on `feat/ux-v2-settings`.
- Plan [2026-05-04-001-feat-desktop-design-overhaul-plan.md](./2026-05-04-001-feat-desktop-design-overhaul-plan.md) — broader desktop design overhaul context.
