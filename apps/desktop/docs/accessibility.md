# Accessibility

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Accessibility

The renderer is audited against WCAG 2.0 / 2.1 / 2.2 Level AA via
`apps/desktop/e2e/a11y.spec.ts`, which launches Electron under the
existing replay-fixture harness and runs `@axe-core/playwright`'s
`AxeBuilder` against each surface. CI picks it up automatically through
`pnpm run test:desktop-e2e` — no separate workflow.

Things to know when extending the audit:

- **Surface coverage.** Each `test(...)` block drives the renderer to a
  state (open thread, settings overlay, settings → messaging, the
  dedicated Star Map window, the Star Map intake dialog) and then calls
  `runAxe(window)`. Add a new block per surface you want gated; go
  through `launchAuditApp()`, which emulates reduced motion and takes an
  optional `fixturePath` / `theme`. A surface in a secondary
  BrowserWindow is a different Playwright `Page`: pass THAT page to
  `runAxe`, and re-emulate reduced motion on it — `launchAuditApp` only
  configured the main window's page.
- **Seed the fixture so the surface is actually populated.** The smoke
  fixture's thread reaches no Star Map lane — `deriveInboxState` keeps a
  first-snapshot thread out of the inbox, and an idle thread with no PR
  and no unpushed commits matches no attention category — so auditing the
  map on it would scan chrome and no cards. `e2e/fixtures/star-map/` is a
  hand-written fixture (same class as `readme-recents-hero/`) whose
  threads are `threadStatus: "active"` for exactly that reason. Check
  what your surface renders before trusting a green run.
- **Some surfaces need seeded sqlite, not a richer fixture.** The active
  sub-agents strip only renders when a thread has a non-terminal sub-agent or
  an undismissed failure, and no replay fixture produces one — every producer
  persists a `ThreadSubAgentSummary` through `upsertThreadSubAgent` into the
  `thread_sub_agents` table. Seed those cards with the overlay store after
  `listThreads` has waited for startup reconciliation. Then reload the window
  so the renderer reads the cards. The audit checks the collapsed header,
  bulk-dismiss control, and each row state before passing those surfaces to axe.
- **Resources state comes from the checkout service, not a mock.**
  `e2e/fixtures/resource-checkout-seeding.ts` writes the authorities file and
  runs `DesktopResourceCheckoutService` from the test process on the app's own
  checkout stores, as a second profile would. Agent holds and queues go in before
  launch; a recovery-required job goes in after the operator's hold is
  released, and the app reads it on its next poll. Never feed the screen the
  preview fixtures.
- **Every surface is audited in every color theme.** The file wraps its
  `describe` in `for (... of AUDIT_APPEARANCES)`: the Tangerine dark and
  light pair plus each other dark theme in the dark scheme and each light
  theme in the light scheme. It threads that appearance into
  `launchAuditApp(appearance)`, so a new block is gated in all of them for
  free. This matters because contrast is the one rule class that is
  genuinely theme-dependent — roles, names, and focus order are not. The
  gate ran dark-only for its whole life, which is how three token-level
  light-theme contrast failures shipped unnoticed. Add a new color theme to
  `AUDIT_DARK_THEMES` or `AUDIT_LIGHT_THEMES`.
- **Work that reads no color runs once.** A color theme sets color tokens
  only. Tangerine dark and light run the full WCAG AA tag set; the other
  color themes run only `COLOR_RULES` (`color-contrast`,
  `link-in-text-block`), through the loop's local `runAxe`. A block whose
  colors a unit test already measures in every theme (the composer
  autocomplete block, through `theme-contract.test.tsx`) runs outside the
  loop in the Tangerine pair, and behavior checks with no scan run only when
  `runsFunctionalChecks` is true (Tangerine dark). Put a new block like that
  in the same place; each Electron launch in the loop costs eleven.
- **`runAxe(window, { include })` narrows the scan to one subtree.** No
  block passes it today, and it is not a tool for silencing a failure —
  everything outside the scope stops being gated. Prefer a
  `KNOWN_VIOLATIONS` entry, which waives one selector for one rule and
  leaves the rest of the surface audited. (It exists because the
  celestial-watermark blocks once scoped to `.thread-view__primary` to
  avoid measuring window-wide light-theme debt; that debt is fixed, light
  theme is gated unscoped, and those blocks folded their
  watermark-is-painted assertion into "open thread view".)
- **Reduced motion has to reach the element that animates.** The gate
  emulates `prefers-reduced-motion: reduce` so it measures contrast at
  rest; a rule that zeroes the animation on the wrong selector leaves
  text mid-fade and axe reports a real-looking contrast miss. That is how
  the Star Map card rise was caught: the animation lives on
  `.star-map-card-shell`, the reduced-motion rule named `.star-map-card`.
- **`setLegacyMode(true)` is required under Electron.** The default
  `AxeBuilder.analyze()` opens a worker page via
  `browserContext.newPage()` to scan cross-origin iframes; Electron's
  CDP target returns "Not supported" for that. The renderer is
  single-origin with no cross-origin iframes, so the legacy
  single-context path covers everything we ship.
- **`KNOWN_VIOLATIONS` is a baseline, not a permission slip.** Each
  entry waives one selector for one rule with a written reason. Fix
  the underlying issue, then delete the entry — axe will hold the
  line on it going forward.
- **No raw color literals outside the token blocks** (see [Implementation
  Notes](renderer-implementation-notes.md#implementation-notes)) — this is also what keeps the contrast pair audited by
  axe stable across theme + density variants.

To run the gate locally:

```bash
pnpm --filter @pwragent/desktop exec playwright test \
  -c playwright.config.ts e2e/a11y.spec.ts
```

(The package's `test:e2e` script checks the Electron runtime and runs a
Vite build first; the `playwright test` form above skips that when you've
already built once.)

### Modal dialogs and overlays

Every `aria-modal` dialog goes through
[`useModalDialog`](../src/renderer/src/lib/useModalDialog.ts). Put its ref on the
element that holds every control of the dialog. Focus then enters on open,
Tab and Shift+Tab stay inside (WCAG 2.1 SC 2.4.3), Escape closes only the
topmost layer, and focus goes back to the opener on close. Before it existed,
most dialogs here had no Escape and no trap, and Tab walked into the dimmed
app behind them.

- **Do not add your own Escape or Tab listener to a dialog.** It becomes a
  second owner of the key. Traps and layers resolve one owner per keypress
  (the one holding focus, deepest first, else the newest), and a private
  listener outside that stack is how one Escape used to close a dialog and
  the find bar behind it.
- **A popup inside a dialog registers with
  [`useDismissableLayer`](../src/renderer/src/lib/useDismissableLayer.ts),** or
  the dialog takes its Escape and both close. Move to Project's destination
  list (`ProjectDestinationCombobox`) is the example.
- **A claimed Escape is prevented and stopped.** A window listener that closes
  something on Escape must check `defaultPrevented`, as `ThreadFindBar` and
  the composer autocomplete do. The stop is for React handlers in a tree the
  dialog portals out of: the Star Map layer drops the card selection on any
  Escape that reaches it.
- **A busy dialog refuses in `onClose`, and the key is still claimed.** Mirror
  the disabled Cancel button; do not let Escape through to what is behind.
- **The opener is captured during render,** because `autoFocus` moves focus
  before any effect can look. A dialog opened from a menu item returns focus
  to the menu's trigger (found through `aria-controls`, or an expanded
  `aria-haspopup` beside the menu). Pass `returnFocus` where nothing marks the
  trigger, as the sidebar's context menu does.
- **`tabIndex={-1}` on the dialog element** when it is the initial focus
  (`initialFocus: "dialog"`), or when every control in it can be disabled at
  once (the Codex login dialog while the login starts). Otherwise focus stays
  behind the scrim. Give such an element `:focus { outline: none }`.
- **Chromium makes an overflowing scroller with nothing focusable in it a Tab
  stop**, though its `tabIndex` reads -1. The trap counts those; a trap that
  cannot see them wraps past them.
- **A dialog with its own Tab order passes `ownTabOrder`.** The jump palette
  steps through the active row's PR chips only; the trap still owns the key
  against a dialog beneath it and fetches stray focus back in.

Test a new dialog with `tabEscapes(dialog)` from
[`src/renderer/src/test/tab-walk.ts`](../src/renderer/src/test/tab-walk.ts). It
walks 60 Tabs each way between sentinel buttons placed before and after the
page, and names every stop outside the dialog that focus reached. jsdom runs
no sequential focus navigation and has no layout, so the helper emulates the
walk and cannot see scroller stops. Check those in headless Chromium.

### Menus

A `role="menu"` goes through
[`useMenuNavigation`](../src/renderer/src/lib/useMenuNavigation.ts). The role
promises the ARIA menu keyboard, and a screen-reader user told "menu" reaches
for the arrows. Focus moves to the first item on open, the arrows, Home and
End move between items, Escape closes and returns focus to the trigger, and
Tab closes and moves on from the trigger. The sidebar's menus said
`role="menu"` and did none of it: opening one left focus on the ⋮ button, and
the menu renders after the whole thread list, so Tab reached it only after
every later row.

- **The hook registers the menu with `useDismissableLayer`.** Do not add an
  Escape listener, and do not register the menu again.
- **Pass the trigger as `triggerRef`.** A menu opened by right-click has no
  button, so record whatever held focus as it opened, as `Sidebar` does with
  `rememberMenuOpener`. A dialog opened from the menu can use the same ref as
  its `returnFocus`.
- **Pass `open` only once the menu can take focus.** The sidebar's floating
  menus measure themselves at `visibility: hidden` before they are placed,
  and Chromium will not focus a hidden element. jsdom will, so only a
  headless-Chromium check catches a menu that opens too early.
- **Mark the trigger.** `aria-haspopup="menu"` plus `aria-expanded`. When the
  trigger sits in a memoized row, pass the row a boolean, not the open row's
  key, or every row re-renders on each open and close.
- **`tabIndex={-1}` on the menu** when every item in it can be disabled at
  once, as the profile menu's can. Focus then lands on the menu, where Escape
  and Tab still work.

### Selects

A single choice from a list goes through
[`Select`](../src/renderer/src/components/Select.tsx), not a native `<select>`.
On macOS, Chromium hands a `<select>` to the system menu, which opens over
the control in the system font and blue highlight, and CSS cannot reach it.

- **It is the ARIA select-only combobox.** The trigger is a
  `<button role="combobox">` that keeps DOM focus while the list is open; the
  keyboard cursor is `aria-activedescendant`. A wrapping `<label>` names it,
  so `getByLabelText` still finds the field.
- **The list is portalled to `document.body`** at `z-index: 150`, above
  Settings and Automations, and registers with `useDismissableLayer`, so
  Escape inside a dialog closes the list alone. Do not add an Escape listener.
- **Tab closes without choosing.** The APG example commits on Tab. Here,
  arrowing past an option on the way out must not change the value.
- **The closed field's chrome comes from its surface,** through `className`
  or a descendant rule (`.automation-field .select-trigger`). The list cannot
  inherit type from the field, so a surface that needs it passes
  `listboxClassName`.
- **Tests drive it through [`test/select.ts`](../src/renderer/src/test/select.ts).**
  `fireEvent.change` does nothing to a button. Choose by label with
  `chooseSelectOption`, read the list with `selectOptionLabels`, and read the
  stored value from `data-value`. Options exist only while the list is open,
  so waiting for `getByRole("option")` to disappear from a closed field passes
  vacuously.
