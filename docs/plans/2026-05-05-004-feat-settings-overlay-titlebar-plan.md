---
title: Title-bar style for Settings overlay (scoped to overlay only)
type: feat
status: completed
date: 2026-05-05
origin: docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md  # U1.3 precedent
---

# Title-bar style for Settings overlay (scoped to overlay only)

## Overview

Replace the current "self-contained mini-shell" header inside the Settings overlay
(duplicate "PwrAgent" brand text + "← Exit Settings" link in an identity column,
plus a giant 34px tangerine "Settings" headline on the right) with a single
title-bar-style strip across the top of the overlay: stoplight gutter, brand
mark, breadcrumb (`Settings › <active section>`), spacer, `MessagingStatusBar`.

The strip lives **inside** the existing `.app-shell__settings-layer` overlay
that already covers the whole window when Settings is active. **Nothing about
the main app screen (Sidebar, ThreadView, ThreadHeader) changes.** Settings
remains a full-screen pushed-onto-stack overlay; we are only restyling the
chrome that's currently inside it.

## Problem Statement / Motivation

**The user has explicitly stated this constraint twice already**, after two
prior attempts in this branch over-reached:
1. First attempt moved Settings out of the overlay and into the main pane next
   to the Sidebar — broke the overlay-on-stack mental model.
2. Second attempt added a global app-wide title bar above both Sidebar and
   Settings — touched the main screen visually.

Both attempts were reset. **This plan locks scope to the overlay's interior.**

What's wrong with the current Settings header:
- Brand text "PwrAgent" duplicates what's already in the Sidebar masthead
  (visible underneath the overlay would be redundant — the overlay covers it
  but cognitively users see two brand presences when entering/exiting).
- The 34px tangerine "Settings" headline is visually loud and doesn't match
  the design's title-bar treatment.
- No `MessagingStatusBar` in Settings means the platform pills disappear
  every time the user opens Settings, even though it's the same app session.
- The "Settings" eyebrow + h1 stack is right-aligned, which the design
  explicitly moves away from in favor of a left-anchored breadcrumb.

The design (`/tmp/pwragent-design/pwragent/project/PwrAgnt v2.html` and
`titlebar.jsx`) shows a unified `pa-tb` strip across the entire app. We are
**not** adopting that part of the design — only the visual style of that
strip, applied **inside the Settings overlay only**.

## Proposed Solution

Two coordinated structural moves inside the Settings overlay (and only there):

**1. New title-bar strip at the top** of the overlay — replaces the existing
`<header className="settings-header">` block. Layout, all on one 44px row:

```
[80px stoplight gutter]  [PwrAgent]   SETTINGS › Messaging          [spacer]      [MSG · TG · DC]
```

The strip contains:
- A reserved 80px left-padding gutter that macOS stoplights overlay (via
  `titleBarStyle: "hiddenInset"`)
- "Pwr**Agent**" brand mark
- Breadcrumb: small uppercase "SETTINGS" eyebrow + chevron + active section
  name (e.g. "Messaging")
- Spacer
- `MessagingStatusBar` platform pills

**Exit Settings is NOT in the strip.** Per the design, `← Exit Settings` is
the **first row of the settings nav** (left column inside the body), above
a "GENERAL" group label that precedes the existing section list.

**2. Settings nav header row** — the existing `<nav className="settings-nav">`
inside `.settings-layout` gains two new prepended elements:
- `← Exit Settings` button as the first row (button styled like a nav row
  but visually distinct)
- "GENERAL" small uppercase group label below it

The existing section buttons (Applications, Worktrees, Messaging, etc.)
follow unchanged.

**CSS changes in `app.css`:**
- Drop the old `.settings-header*` rules (lines 1694–1753) entirely.
- Update `.app-shell__settings-layer` (lines 1663–1672) so the body content
  no longer needs the 42px stoplight clearance — the new strip handles it
  via internal left-padding.
- Add `.settings-titlebar*` rules for the new strip.
- Add `.settings-nav__exit` + `.settings-nav__group-label` rules for the new
  nav header rows.

The existing `.settings-layout` grid (188px nav + content) stays exactly
as-is. The existing `.settings-nav__button` rule and the per-section
content panels are untouched.

`MessagingStatusBar` is dropped into the strip's actions slot. It's a
self-contained component (`apps/desktop/src/renderer/src/features/messaging-status/MessagingStatusBar.tsx:35-69`)
that renders nothing when no platforms are configured — safe to drop in.
Clicking a platform chip switches the active section to `messaging-activity`,
mirroring the existing affordance from `ThreadHeader`.

## Technical Approach

### Architecture

The Settings overlay is mounted by `App.tsx:247-256` when `mainView ===
"settings"`. It's an absolute-positioned `<div className="app-shell__settings-layer">`
with `inset: 0`, `z-index: 30`, covering the whole window. **This stays.**

Inside that overlay, `SettingsScreen` renders:
- A `<header>` block (today: `.settings-header`; new: `.settings-titlebar`)
- A `.settings-layout` grid with nav + content

The DOM tree changes only inside `<header>`. Everything below stays.

### File scope

#### Files this plan WILL touch

| File | Edit |
|---|---|
| `apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx` | (a) Replace `<header className="settings-header">…</header>` block (lines 54–73) with the new `<header className="settings-titlebar">…</header>` (no Exit button inside). (b) Prepend `← Exit Settings` button + "General" group label to `<nav className="settings-nav">` (lines 76–88), above the existing `SECTIONS.map`. Add `MessagingStatusBar` import. Compute `activeSectionLabel`. Add `onOpenActivity` callback. |
| `apps/desktop/src/renderer/src/styles/app.css` | Delete `.settings-header*` block (lines 1694–1753). Update `.app-shell__settings-layer` (lines 1663–1672) — drop the `padding: 42px 24px 24px`, replace with `padding: 0` (the strip + body handle their own padding). Add `.settings-titlebar*` rules. Add `.settings-nav__exit` + `.settings-nav__group-label` rules for the new nav header rows. |
| `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx` | Add 5 focused tests locking the new structure: strip contains brand+breadcrumb+MessagingStatusBar, no level-1 heading, breadcrumb reflects active section, platform-chip click jumps to messaging-activity, **Exit Settings lives in `.settings-nav` and NOT in `.settings-titlebar`**, "General" group label renders between Exit and the section list. Existing tests pass without modification. |

#### Files this plan WILL NOT touch (hard guard rails)

| File | Why locked |
|---|---|
| `apps/desktop/src/renderer/src/App.tsx` | Settings still mounted via `mainView === "settings"` overlay. No body-grid changes. No global title bar above body. |
| `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx` | Brand text + masthead drag region + 80px stoplight gutter must stay. |
| `apps/desktop/src/renderer/src/features/thread-detail/ThreadHeader.tsx` | Continues to render its own MessagingStatusBar. Main-screen chrome unchanged. |
| `apps/desktop/src/renderer/src/features/thread-detail/ThreadView.tsx` | Untouched. |
| `apps/desktop/src/main/window.ts` | `titleBarStyle: "hiddenInset"` and `trafficLightPosition: { x: 20, y: 18 }` stay. No fake stoplights drawn. |
| `apps/desktop/src/renderer/src/styles/app.css` rules outside `.settings-header*` and `.app-shell__settings-layer` | All other selectors untouched. No edits to `.sidebar__*`, `.thread-header*`, `.app-shell` (the grid stays `<sidebar> | <main>`), `.app-main`, `.thread-view`, etc. |

### Implementation Units

#### U1. JSX restructure in SettingsScreen.tsx

**Goal:** Replace the existing header block with the new title-bar strip
and move "Exit Settings" + a "GENERAL" group label into the top of the
settings nav.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx`
  (header block at lines 54–73 + nav block at lines 76–88 + `useState` site)

**Approach:**

```tsx
// SettingsScreen.tsx — additions at the top
import { useCallback, useEffect, useState } from "react";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import type {
  // … existing imports …
  MessagingChannelKind,
} from "@pwragent/shared";

// Inside SettingsScreen:
const activeSectionLabel =
  SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings";

const onOpenActivity = useCallback(
  (_platform?: MessagingChannelKind) => {
    setSection("messaging-activity");
  },
  [],
);

return (
  <section className="settings-screen" aria-label="Settings">
    {/* Title bar strip — brand + breadcrumb + messaging pills.
        Exit Settings is NOT here; it lives at the top of the nav
        below (matches the design exactly). */}
    <header className="settings-titlebar">
      {/* Stoplight gutter is reserved via padding-left: 80px in CSS;
          no DOM element needed here. */}
      <p className="settings-titlebar__brand">
        Pwr<span className="settings-titlebar__brand-accent">Agent</span>
      </p>
      <div className="settings-titlebar__breadcrumb">
        <span className="settings-titlebar__eyebrow">Settings</span>
        <span aria-hidden="true" className="settings-titlebar__separator">›</span>
        <span
          className="settings-titlebar__current"
          title={activeSectionLabel}
        >
          {activeSectionLabel}
        </span>
      </div>
      <div className="settings-titlebar__spacer" />
      <MessagingStatusBar
        desktopApi={props.desktopApi}
        onOpenActivity={onOpenActivity}
      />
    </header>

    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {/* New: Exit row at the top of the nav. Styled as its own
            class (`settings-nav__exit`) so it visually reads
            distinct from the section buttons below. */}
        {props.onClose ? (
          <button
            className="settings-nav__exit"
            type="button"
            onClick={props.onClose}
          >
            <span aria-hidden="true">←</span> Exit Settings
          </button>
        ) : null}

        {/* New: small uppercase group label, matching design's
            "GENERAL" header above the section list. */}
        <p className="settings-nav__group-label">General</p>

        {/* Existing section buttons — unchanged. */}
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            aria-current={section === item.id ? "page" : undefined}
            className={`settings-nav__button${section === item.id ? " is-active" : ""}`}
            type="button"
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="settings-content">
        {/* Unchanged. */}
      </div>
    </div>
  </section>
);
```

**Verification:** existing settings-screen tests pass without changes —
Exit Settings is still queryable via `getByRole("button", { name: /Exit Settings/i })`,
just rooted in the nav instead of the header. Section nav still works, form
interactions unaffected.

**Execution note:** JSX-only diff plus three small additions (import,
`activeSectionLabel`, `onOpenActivity`). The Exit button moves DOM
locations but its accessible name + click handler are unchanged. No
state-shape changes. No prop contract changes.

#### U2. CSS for `.settings-titlebar*` and overlay padding update

**Goal:** Replace `.settings-header*` rules with `.settings-titlebar*` rules
that emulate the design's `pa-tb` strip but scoped to inside the overlay.

**Files:**
- update: `apps/desktop/src/renderer/src/styles/app.css` only (lines 1663–1753)

**Rules to delete (lines 1694–1753):**
- `.settings-header { display: flex; … padding-right: 8px; -webkit-app-region: drag; }`
- `.settings-header__identity { … }`
- `.settings-header__brand { … }`
- `.settings-header__exit { … }` and its `:hover/:focus-visible` rules
- `.settings-header__title { text-align: right; }`
- `.settings-header h1 { … 34px … }`

**Rule to update (lines 1663–1672):**

```css
/* BEFORE */
.app-shell__settings-layer {
  display: flex;
  position: absolute;
  z-index: 30;
  inset: 0;
  min-width: 0;
  min-height: 0;
  padding: 42px 24px 24px;  /* 42px top was stoplight clearance */
  background: var(--bg-app);
}

/* AFTER */
.app-shell__settings-layer {
  display: flex;
  position: absolute;
  z-index: 30;
  inset: 0;
  min-width: 0;
  min-height: 0;
  /* No padding — the title-bar strip handles its own stoplight
     clearance via padding-left: 80px (matches .sidebar__masthead).
     The body section below the strip carries its own interior
     padding via .settings-layout's own grid + the existing card
     borders, so we don't need an outer interior gutter here. */
  padding: 0;
  background: var(--bg-app);
}

/* The flex direction needs to be column now since the layer holds
   the strip on top and the body grid below (currently the layer's
   only child is .settings-screen which already does this — no
   change required to the layer's flex axis). */
```

**Mobile override (lines 5650–5654):** keep the `position: fixed` switch but
update the padding strategy similarly. Honestly, the mobile breakpoint of the
Settings overlay isn't a primary target right now (this is a desktop Electron
app); leave the mobile rule's existing padding alone and let the strip's
internal padding-left handle clearance there too.

**New rules to add (replacing the `.settings-header*` block):**

```css
/* Settings overlay's internal title-bar strip. Mirrors the design's
   `pa-tb` strip from PwrAgnt v2.html, but scoped to the overlay only.
   Main-screen chrome (Sidebar masthead, ThreadHeader) is intentionally
   not affected by this work — see plan
   docs/plans/2026-05-05-004-feat-settings-overlay-titlebar-plan.md. */

.settings-titlebar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
  height: 44px;
  /* Left padding clears macOS stoplights (drawn by hiddenInset at
     x=20, y=18 with three 12px buttons + ~8px spacing = ~70px
     extent). Matches `.sidebar__masthead` which uses 80px for the
     same reason. */
  padding: 0 14px 0 80px;
  background: var(--bg-titlebar, var(--bg-panel-elevated));
  border-bottom: 1px solid var(--border-subtle);
  /* Whole strip is a drag region; interactive elements opt back to
     no-drag below (same pattern as .sidebar__masthead and
     .thread-header). */
  -webkit-app-region: drag;
}

.settings-titlebar * {
  -webkit-app-region: drag;
}

.settings-titlebar button,
.settings-titlebar input,
.settings-titlebar a,
.settings-titlebar select,
.settings-titlebar [role="button"] {
  -webkit-app-region: no-drag;
}

/* MessagingStatusBar already enforces no-drag on its whole subtree
   via its own CSS (app.css ~line 211). No duplication needed here. */

.settings-titlebar__brand {
  margin: 0;
  flex: 0 0 auto;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.005em;
}

.settings-titlebar__brand-accent {
  color: var(--accent);
}

.settings-titlebar__breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.settings-titlebar__eyebrow {
  /* Reuses the visual treatment of `.eyebrow` but local to the strip
     so we can size it to 10px/uppercase like the design's
     pa-tb__crumb-eyebrow. */
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.settings-titlebar__separator {
  flex: 0 0 auto;
  color: var(--text-subtle);
}

.settings-titlebar__current {
  min-width: 0;
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-weight: 600;
}

.settings-titlebar__spacer {
  flex: 1 1 auto;
  min-width: 0;
}

/* Nav-side header rows — Exit button + GENERAL group label, both
   prepended to the existing section list. Visually distinct from
   the section buttons so users don't mistake "← Exit Settings" for
   another section. */

.settings-nav__exit {
  display: inline-flex;
  width: 100%;
  align-items: center;
  appearance: none;
  cursor: pointer;
  gap: 6px;
  /* Match the vertical rhythm of section buttons (10px 12px) so the
     nav reads as one tight column. */
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}

.settings-nav__exit:hover,
.settings-nav__exit:focus-visible {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--text-primary);
  outline: none;
}

.settings-nav__group-label {
  margin: 4px 12px 6px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

**Verification:** Render Settings overlay in dev (`pnpm --filter @pwragent/desktop dev:no-messaging`).
Visual checks:
1. macOS stoplights overlay the strip's left 80px gutter (same as today over the sidebar masthead).
2. Drag works on empty strip space (brand text and breadcrumb are draggable; MessagingStatusBar pills are click-only).
3. The strip itself contains NO Exit button — Exit Settings is the first row of the settings nav (left column inside the body).
4. Settings nav order top-to-bottom: `← Exit Settings` (bordered button), `GENERAL` (small uppercase label), then existing section buttons.
5. Clicking Exit Settings still closes back to thread view (existing `onClose` flow).
6. Breadcrumb in the strip updates as user clicks each section.
7. With Telegram/Discord configured, the platform pills appear in the strip's right edge with status dots.
8. The existing `.settings-content` (right column) is visually unchanged from today.

**Execution note:** CSS-only diff. No JS changes here.

#### U3. Tests

**Goal:** Lock the new contracts so a future revert can't slip back.

**Files:**
- update: `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx`

**Approach:** Add focused tests; existing tests stay unchanged.

```tsx
// New test block alongside existing ones:

it("renders the Settings overlay's title-bar strip with brand + breadcrumb + MessagingStatusBar", async () => {
  // Stubs MessagingStatusBar's hook so it has at least one platform
  // to render; without it the bar returns null.
  const desktopApi = {
    getMessagingPlatformStatuses: vi.fn(async () => [
      {
        platform: "telegram" as const,
        health: "enabled" as const,
        changedAt: 0,
      },
    ]),
  } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

  const { container } = render(
    <SettingsScreen
      desktopApi={desktopApi}
      settings={createSettingsState()}
      onClose={() => undefined}
    />,
  );

  // The new strip uses `.settings-titlebar` — old `.settings-header`
  // is gone.
  expect(container.querySelector(".settings-titlebar")).not.toBeNull();
  expect(container.querySelector(".settings-header")).toBeNull();

  // Brand text + accent split.
  expect(
    container.querySelector(".settings-titlebar__brand-accent"),
  ).not.toBeNull();

  // The 34px tangerine "Settings" h1 from the old layout is gone.
  expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

  // MessagingStatusBar is mounted in the strip; wait for the
  // async platform-status hook to resolve.
  await waitFor(() => {
    expect(container.querySelector(".messaging-status-bar")).not.toBeNull();
  });
});

it("shows the active section's label in the breadcrumb's current slot", () => {
  render(
    <SettingsScreen
      settings={createSettingsState()}
      initialSection="messaging"
      onClose={() => undefined}
    />,
  );

  const current = document.querySelector(".settings-titlebar__current");
  expect(current).not.toBeNull();
  expect(current?.textContent).toBe("Messaging");
});

it("switches to the messaging-activity section when a platform chip is clicked", async () => {
  const desktopApi = {
    getMessagingPlatformStatuses: vi.fn(async () => [
      {
        platform: "telegram" as const,
        health: "enabled" as const,
        changedAt: 0,
      },
    ]),
  } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

  render(
    <SettingsScreen
      desktopApi={desktopApi}
      settings={createSettingsState()}
      onClose={() => undefined}
    />,
  );

  const chip = await screen.findByRole("button", { name: /Telegram/i });
  fireEvent.click(chip);

  // Active section flipped to messaging-activity.
  await waitFor(() => {
    const current = document.querySelector(".settings-titlebar__current");
    expect(current?.textContent).toBe("Messaging activity");
  });
});

it("places Exit Settings as the first row of the settings nav (NOT in the title bar)", () => {
  // Regression lock: Exit Settings must live INSIDE the
  // `.settings-nav` (left column), as the first interactive row.
  // The title bar must NOT contain it. Matches design exactly.
  render(
    <SettingsScreen
      settings={createSettingsState()}
      onClose={() => undefined}
    />,
  );

  const exit = screen.getByRole("button", { name: /Exit Settings/i });

  // Inside the nav, NOT inside the title bar.
  expect(exit.closest(".settings-nav")).not.toBeNull();
  expect(exit.closest(".settings-titlebar")).toBeNull();

  // Uses the dedicated nav-exit class so a future revert can't put
  // it back in the title bar without breaking this assertion.
  expect(exit).toHaveClass("settings-nav__exit");
});

it("renders a 'General' group label between Exit Settings and the section list", () => {
  render(
    <SettingsScreen
      settings={createSettingsState()}
      onClose={() => undefined}
    />,
  );

  const label = document.querySelector(".settings-nav__group-label");
  expect(label).not.toBeNull();
  expect(label?.textContent?.toLowerCase()).toBe("general");
});
```

**Execution note:** Test-additions only; do not modify existing test cases.

## Acceptance Criteria

### Functional

- [ ] Opening Settings shows the new strip at the top of the overlay with:
  - 80px left gutter where macOS stoplights overlay
  - "Pwr**Agent**" brand text
  - Breadcrumb: `Settings › <active section>` (e.g. `Settings › Messaging`)
  - Spacer
  - `MessagingStatusBar` pills on the right (when platforms are configured)
- [ ] **Exit Settings is NOT in the title-bar strip.** It's the first row of
      the settings nav (left column inside the body), styled as a bordered
      button distinct from the section buttons below it.
- [ ] **A "General" group label** sits between Exit Settings and the existing
      section list (Applications, Worktrees, Messaging, …) in the nav.
- [ ] Clicking each nav section updates the breadcrumb text in the strip in
      real time.
- [ ] Clicking a platform chip in the strip switches the section to "Messaging activity".
- [ ] Drag region works: dragging from any empty strip space moves the window;
      brand, breadcrumb, and platform pills do NOT initiate a drag.
- [ ] "← Exit Settings" returns to the thread view (existing `onClose` flow).
- [ ] No 34px tangerine "Settings" headline anywhere in the overlay.

### Non-functional

- [ ] **Main app screen has zero visual changes.** Sidebar masthead's brand,
      Settings cog, New-thread button, lens switch, thread list, runtime
      identity chips all render identically to before. ThreadView header still
      shows backend/execution-mode chips and the `MessagingStatusBar`.
- [ ] macOS stoplights still drawn by the OS via `titleBarStyle: "hiddenInset"`
      at `trafficLightPosition: { x: 20, y: 18 }`. The 80px strip gutter clears
      them. No fake stoplights drawn.
- [ ] `BrowserWindow.titleBarStyle` and `trafficLightPosition` in
      `apps/desktop/src/main/window.ts` are NOT changed.
- [ ] `App.tsx`'s `.app-shell` grid stays `<sidebar> | <main>` (no third row,
      no top title bar above the body).
- [ ] No new `-webkit-app-region` rules outside `.settings-titlebar*`.

### Quality gates

- [ ] `pnpm --filter @pwragent/desktop typecheck` clean.
- [ ] `pnpm test` passes the existing 1150 cases plus the 5 new ones added in U3.
- [ ] `pnpm lint` passes.
- [ ] Visual smoke check: open Settings → click each section → click a platform
      chip → click Exit Settings. All transitions render correctly.

## System-Wide Impact

### Interaction graph

- **Open Settings:** Sidebar's `onOpenSettings` → `App.tsx::setMainView("settings")`
  → `<SettingsScreen>` mounts inside `<.app-shell__settings-layer>`. **Unchanged.**
- **Click section:** `<button onClick={() => setSection(item.id)}>` →
  `useState` updates → re-render. The new strip's breadcrumb reads `section`
  through `SECTIONS.find()` and renders the new label.
- **Click platform chip:** `MessagingStatusBar`'s `onOpenActivity(platform)` →
  `setSection("messaging-activity")`. Same pattern as `ThreadHeader`'s deep-link.
- **Click Exit Settings:** `props.onClose()` → `App.tsx::setMainView("thread")`.
  **Unchanged** behavior; only the button's location and styling differ.

### Error & failure propagation

- `MessagingStatusBar` already returns `null` when no platforms are configured
  (line 49 of `MessagingStatusBar.tsx`). Failure of `getMessagingPlatformStatuses`
  resolves to empty list — strip silently shows no pills. No new error paths.
- `SettingsScreen`'s existing settings-load error states (loading / fatal /
  configError) render below the strip in the body area; the strip itself
  doesn't depend on `snapshot`, so it's always visible.

### State lifecycle risks

- `section` state stays inside `SettingsScreen` (unchanged). No state lift
  needed.
- `onOpenActivity` callback in `useCallback` — recreated only when the
  component remounts. Safe.

### API surface parity

- **Sidebar masthead** still has its brand. **Cognitively redundant** when
  Settings is open (overlay covers it), but visually fine because the user
  doesn't see both at once.
- **ThreadHeader's MessagingStatusBar** is a separate instance from the new
  one in Settings. Each fetches its own statuses via `useMessagingPlatformStatuses`
  — both subscribe to the same underlying IPC stream. No coordination needed.

### Integration test scenarios

1. Open Settings → drag from middle of strip → window moves. Click Exit
   Settings (button doesn't drag).
2. Open Settings with Telegram configured → strip shows TG pill. Click it →
   section switches to "Messaging activity".
3. Open Settings → switch through every section in the nav → breadcrumb
   reflects each label correctly.
4. Open Settings with messaging globally disabled → strip's pills show "off"
   color (existing `MessagingStatusBar` behavior).
5. Resize the sidebar (in the main screen below) → does NOT change the
   Settings overlay since the overlay covers everything.

## Alternative Approaches Considered

1. **Adopt the design's unified app-wide title bar** (replace the whole top
   chrome of the app with one strip). **Rejected** — user has explicitly said
   "NO CHANGES to non-Settings page visually" twice. Two prior attempts in
   this branch have done this and been reset. The design's unified bar is a
   future migration if the user changes their mind, not this work.

2. **Keep the brand inside the overlay header but drop only the giant
   "Settings" h1.** Half-measure. Doesn't bring the strip up to design parity
   on placement (no breadcrumb, no MessagingStatusBar). Rejected as not
   achieving the user's "make Settings look more like main on that" intent.

3. **Move "← Exit Settings" into the top of the `.settings-nav` left column**
   (matches design's `settings.jsx`). **Deferred.** Keeping Exit in the strip
   for this round preserves the existing E2E test selectors and gives a
   single visual change to review. Can be revisited as part of the per-section
   work that's planned for after this commit lands.

4. **Add the title-bar strip ABOVE the overlay** (so it persists when
   transitioning between Settings and main). **Rejected** — that's exactly
   the global app-wide title bar from rejected option 1, just from the other
   direction. Strip stays inside the overlay.

## Dependencies & Prerequisites

- None for code. The MessagingStatusBar already exists and is stable.
- Design source bundle at `/tmp/pwragent-design/pwragent/project/` is local
  and has been read. The design's `pa-tb*` token names inform our naming
  (we use `settings-titlebar*` to scope to this overlay).

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stoplight clearance drift on the strip | Low | High (clicks miss / drag misroutes) | Mirror `.sidebar__masthead`'s exact 80px left padding; manual visual check before merge. |
| Drag region breaks for any element inside the strip | Medium | High | Carry forward the `* { drag }` + `button/input/a/select/[role="button"] { no-drag }` pattern that's already proven on `.sidebar__masthead` and `.thread-header`. |
| Test flake from MessagingStatusBar's async hook | Low | Low | Use `waitFor()` on `.messaging-status-bar` selector — same pattern used elsewhere in the test suite. |
| User opens main screen and notices unintended change | Medium (history-based) | High | **Hard guard rail:** zero edits to any file outside `SettingsScreen.tsx`, the test file, and the `.settings-header*` + `.app-shell__settings-layer` CSS rules. Post-implementation: diff all changed files and confirm nothing outside this scope was touched before committing. |
| Mobile breakpoint regresses | Low | Low | Existing mobile override at lines 5650–5654 already uses `position: fixed` and its own padding; the strip's internal padding handles clearance there too. Mobile is not a target environment. |

## Resource Requirements

- One developer, one session. Estimated effort: 30–60 min for code + tests, 15
  min for visual smoke check.

## Future Considerations

- The unified design title bar (option 1 above) remains an option if the user
  ever wants a full app-shell redesign. Adopting it would be straightforward
  from this state because we've already named the new selectors
  (`settings-titlebar*`) without colonising the global namespace — moving the
  strip's structure to a global location later requires only renaming.
- Per-section visual polish (eyebrows, card layouts, Test connection pills
  for Messaging/Models — see `2026-05-04-001-feat-desktop-design-overhaul-plan.md`
  U1.4) is the natural next phase once this strip lands.

## Documentation Plan

- No README/AGENTS changes required. The existing `docs/UI-THEME.md` covers
  general theme tokens; this work doesn't introduce new tokens (it reuses
  existing `--text-primary`, `--accent`, `--border-subtle`, etc.).

## Sources & References

### Origin

- **Origin plan:** [docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md](docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md)
  - U1.3 "Settings screen layout rework" describes a broader Settings redesign
    that includes the brand/Exit-Settings/two-column-help layout. This plan
    covers a subset: just the title-bar-style strip at the top, scoped to the
    overlay, with no main-screen impact.
  - U1.3's regression guard ("must NOT shift the title-bar drag region or
    break stoplight alignment") carries forward verbatim — this plan adopts
    the existing 80px left-padding pattern from `.sidebar__masthead`.

### Internal references

- `apps/desktop/src/renderer/src/App.tsx:247-256` — Settings overlay mount.
- `apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx:42-73`
  — current header markup to replace.
- `apps/desktop/src/renderer/src/styles/app.css:1663-1753` — current Settings
  CSS rules to update / delete.
- `apps/desktop/src/renderer/src/styles/app.css:149-180` — `.sidebar__masthead`
  pattern to mirror (80px gutter + drag region).
- `apps/desktop/src/renderer/src/styles/app.css:182-218` — `.thread-header` +
  `.messaging-status-bar` no-drag pattern to mirror.
- `apps/desktop/src/renderer/src/features/messaging-status/MessagingStatusBar.tsx:35-69`
  — drop-in component, no API changes needed.
- `apps/desktop/src/main/window.ts:86-87` — `hiddenInset` + `trafficLightPosition`
  (DO NOT change).

### Design source

- `/tmp/pwragent-design/pwragent/project/PwrAgnt v2.html` — design entry point.
- `/tmp/pwragent-design/pwragent/project/titlebar.jsx:92-148` — design's
  TitleBar JSX shape (informs the strip's slot layout).
- `/tmp/pwragent-design/pwragent/project/styles.css:25-230` — `pa-tb*`
  reference styles. We do NOT port these wholesale; we carry the visual
  intent (44px tall, drag region, 80px stoplight gutter, brand on left,
  spacer, actions on right) but use locally-scoped class names.

### Related work

- Branch `feat/ux-v2-settings` has had two prior attempts at this work that
  were both reset to `origin/main`. Both attempts over-reached by changing
  the main-screen layout. **This plan exists to lock scope so the third
  attempt lands cleanly.**
- Prior reset commits (force-pushed away):
  - `30774aee` — too aggressive: moved Settings to live next to Sidebar.
  - `0b58ca4c` — too aggressive: added a full-width app-wide title bar above
    the body.
