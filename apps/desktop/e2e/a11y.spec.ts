// Renderer accessibility gate. Runs axe-core via @axe-core/playwright
// against a handful of high-traffic UI surfaces inside a real Electron
// launch (the same fixture/replay harness every other e2e spec uses),
// and asserts zero WCAG 2.0/2.1/2.2 AA violations.
//
// We intentionally use the actual Electron renderer (not a jsdom render
// of individual components) so that real styling from app.css — focus
// rings, contrast, sticky-header layout — gets audited as it actually
// ships. The cost is one Electron launch per surface; the coverage is
// what a screen-reader / keyboard-only operator actually encounters.
//
// To extend: add another entry to SURFACES below, or a separate
// `test(...)` block that drives the renderer into a state (open a
// dialog, switch a tab) and then calls `runAxe(window)`. Launch via
// `launchAuditApp({ theme })` so the surface is audited at rest (see below).
//
// Every surface is audited in BOTH themes. The gate ran dark-only for
// its whole life, which is exactly why three light-theme token-level
// contrast failures shipped unnoticed: `--accent` at 4.20:1 on the
// sidebar wordmark, `--accent-bright` at 3.17:1 on the active lens tab,
// and `--text-muted` at 4.23:1 on the .context-grid thread-info labels.
// Contrast is the one rule class that is genuinely theme-dependent —
// roles, names, and focus order are not — so auditing a single theme
// buys roughly half the coverage it appears to.
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { DesktopAppearanceTheme } from "@pwragent/shared";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Audit the settled, at-rest visual state. Several surfaces play a brief
// mount/enter animation — e.g. the pinned context rail's `.context-panel`
// runs a 220ms `context-panel-in` opacity 0 -> 1 fade — and these are all
// already disabled under `@media (prefers-reduced-motion: reduce)`. While
// such a fade is in flight, axe-core blends a partially transparent
// element's text toward its background and reports a transient
// color-contrast miss on text that comfortably passes AA at rest. The
// empty-thread shell's six `.context-grid dt` labels (`--text-muted`,
// ~5.4:1 on the panel — just above the 4.5:1 line) are the first to dip
// under mid-fade, which is exactly the intermittent
// `div:nth-child(1..6) > dt` failure this gate used to flake on. Emulating
// reduced motion makes every audited surface paint its non-animating
// state, so the gate measures real, persistent contrast instead of a
// sub-second animation frame. No renderer JS branches on reduced motion,
// so this only settles CSS animation — it never changes what renders.
async function launchAuditApp(options?: {
  /** Defaults to the smoke fixture; pass another to seed a richer state. */
  fixturePath?: string;
  /** Defaults to the harness default (dark). */
  theme?: DesktopAppearanceTheme;
}) {
  const app = await launchElectronApp({
    fixturePath:
      options?.fixturePath
      ?? path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    ...(options?.theme ? { appearance: { theme: options.theme } } : {}),
  });
  await app.window.emulateMedia({ reducedMotion: "reduce" });
  return app;
}

// The smoke thread never reaches the Star Map: `deriveInboxState` keeps a
// first-snapshot thread out of the inbox, and with no PR, no unpushed
// commits and an idle status it matches none of the attention categories,
// so the smoke fixture's map is bodies-and-chrome with zero cards. The
// cards are exactly what carries the contrast risk (title and status
// indicator over the star field, meta chips, the low-opacity instance
// watermark behind them), so the map audits run against a fixture whose
// threads are `threadStatus: "active"` and therefore populate a lane.
//
// Both themes ship, so both themes are gated. See the header note.
// `as const`, not `readonly DesktopAppearanceTheme[]` — that type also
// admits "system", which resolves through the OS and lands on light on
// most Linux runners (see the note on `appearance` in
// fixtures/electron-app.ts). Pinning the literals keeps a
// nondeterministic third entry from typechecking its way in.
const AUDIT_THEMES = ["dark", "light"] as const satisfies readonly DesktopAppearanceTheme[];

// Its threads carry linked directories on purpose. A project chip renders
// through `CopyableThreadChip`, a `role="button" tabIndex={0}` span, and
// the row/card used to wrap their whole content in a real `<button>` — so
// any fixture with a directory tripped `nested-interactive` on BOTH
// surfaces, and these threads had to stay directory-less to keep the gate
// green. That debt is paid: the chip flow is now a SIBLING of the
// open-thread button on both surfaces (the shape `.star-map-card-shell`
// already used for its kebab), so the chips are the point of the fixture
// rather than a landmine in it. Keep the directories — they are what
// stops the nesting from creeping back, on the card and on the sidebar
// row behind it.
const STAR_MAP_FIXTURE = path.resolve(
  specDir,
  "fixtures/star-map/replay.fixture.json",
);

const COPY_CHIP_FIXTURE = path.resolve(
  specDir,
  "fixtures/a11y-copy-chips/replay.fixture.json",
);

const WCAG_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

// Selectors waived from the axe scan, with a written reason. The
// baseline is empty — every previously waived violation has been
// fixed in the renderer. If a new pre-existing violation surfaces
// (e.g. on a new surface added to the suite below) and is too
// invasive to fix in the same PR, add an entry here so the gate
// stays green AND surfaces the debt, then file a follow-up.
const KNOWN_VIOLATIONS: ReadonlyArray<{
  selector: string;
  rule: string;
  reason: string;
}> = [];

async function runAxe(
  window: Page,
  options?: {
    /**
     * Narrow the scan to one subtree. Use it only when the test is about
     * a specific composited surface rather than the whole window — an
     * unscoped run is the default because it is what catches regressions
     * nobody thought to point at. Never reach for it to make a fresh
     * failure go away: everything outside the scope stops being gated,
     * whereas a KNOWN_VIOLATIONS entry waives one selector for one rule
     * and leaves the rest of the surface audited.
     *
     * No block passes this today. It was added by #1303 so the
     * celestial-watermark blocks could scope to `.thread-view__primary`
     * and measure the watermark rather than the window-wide light-theme
     * contrast debt that existed then. That debt is fixed and light
     * theme is now gated unscoped like dark, so the scoping came out.
     * Kept as the documented affordance for the next surface that
     * genuinely needs it.
     */
    include?: string;
  },
): Promise<void> {
  // setLegacyMode is required under Electron: the default analyze()
  // path tries to spawn a worker page via browserContext.newPage() to
  // audit cross-origin iframes, which Electron's CDP target doesn't
  // support and fails with "Protocol error (Target.createTarget): Not
  // supported". The renderer is single-origin (app://) with no
  // cross-origin iframes, so the legacy single-context path covers
  // everything we render anyway. See
  // https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/error-handling.md
  let builder = new AxeBuilder({ page: window })
    .withTags(WCAG_AA_TAGS)
    .setLegacyMode(true);
  if (options?.include) {
    builder = builder.include(options.include);
  }
  for (const known of KNOWN_VIOLATIONS) {
    // exclude() removes the node from the scan entirely. Combined with
    // the .rule mapping in KNOWN_VIOLATIONS above, this gives an
    // auditable list of waived selectors instead of a global rule
    // disable that would hide regressions on other surfaces.
    builder = builder.exclude(known.selector);
  }
  const results = await builder.analyze();

  // Surface the human-readable summary on failure so the CI log tells
  // you which rules + selectors failed without having to download the
  // Playwright trace artifact.
  if (results.violations.length > 0) {
    const summary = results.violations
      .map((violation) => {
        const nodes = violation.nodes
          .map((node) => `    - ${node.target.join(" ")}`)
          .join("\n");
        return `  ${violation.id} (${violation.impact ?? "n/a"}): ${violation.help}\n${nodes}\n    ${violation.helpUrl}`;
      })
      .join("\n");
    throw new Error(
      `axe-core found ${results.violations.length} WCAG2 AA violation(s):\n${summary}`,
    );
  }
}

for (const theme of AUDIT_THEMES) {
  test.describe(`desktop renderer accessibility (WCAG2 AA, ${theme} theme)`, () => {
    test("sidebar + empty-thread shell has no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        // Wait for first paint of the inbox lens — the "Replay smoke
        // thread" row is the proxy for "renderer has hydrated".
        await expect(
          app.window.getByRole("button", { name: /Replay smoke thread/i }).first(),
        ).toBeVisible();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    // The smoke thread above has no linked directories and no branch, so
    // its row renders none of the click-to-copy chips
    // (`CopyableThreadChip` — a `role="button"` span). Those chips are what
    // made the row's own button a `nested-interactive` violation, so the
    // block above cannot catch a regression of it. This one audits a row
    // carrying all three chip flavours: a worktree directory, a local one,
    // and a branch.
    //
    // Its own fixture, deliberately, on two counts. STAR_MAP_FIXTURE
    // carries directories now, but its threads are
    // `threadStatus: "active"`, so the thread view renders its
    // `.transcript-list__pending` live region — a `role="status"` sibling
    // of the `role="listitem"` entries inside `.transcript-list__items`,
    // which is a `role="list"`. That trips `aria-required-children`,
    // pre-existing transcript debt unrelated to the chips. (The map blocks
    // below miss it only because the map layer covers the thread view.)
    // Borrowing another spec's fixture would work too, but this gate's
    // coverage would then hinge on a file it does not own: drop a directory
    // there and this block goes quiet with no failure anywhere. An idle
    // thread also keeps the scan UNSCOPED — narrowing it with `include` is
    // the cheap way out and would stop this block catching anything outside
    // the sidebar.
    test("sidebar rows carrying copy chips have no violations", async () => {
      const app = await launchAuditApp({
        theme,
        fixturePath: COPY_CHIP_FIXTURE,
      });
      try {
        // The branch chip renders last of the row's copy chips, so waiting
        // on it means the linked-directory chips are up too.
        await expect(
          app.window.getByRole("button", {
            name: "Copy branch feature/copy-chip-audit",
          }),
        ).toBeVisible();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    test("open thread view has no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        await app.window
          .getByRole("button", { name: /Replay smoke thread/i })
          .first()
          .click();
        await expect(
          app.window.getByRole("heading", {
            level: 2,
            name: "Replay smoke thread",
          }),
        ).toBeVisible();
        await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
        // The celestial watermark paints the owning instance's mark behind
        // the transcript at 0.05 opacity, tinted with `--text-muted`. That
        // is a real compositing input to every contrast pair in the thread
        // body, and it resolves differently per theme — a value harmless
        // behind a dark surface can eat the margin on a light one. Assert
        // it is actually painted, or the audit below keeps passing after a
        // regression that stopped rendering it. It is aria-hidden, so it
        // has no role to locate it by; the class IS the contract the a11y
        // note in app.css points at. (Added by #1303 as its own scoped
        // pair of blocks; folded in here once light theme went AA-clean
        // window-wide and the scoping stopped being needed.)
        await expect(
          app.window.locator(".thread-view__primary .celestial-watermark"),
        ).toHaveCount(1);
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    test("settings overlay has no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        await expect(
          app.window.getByRole("button", { name: /Replay smoke thread/i }).first(),
        ).toBeVisible();
        await app.window.getByRole("button", { name: "Open settings" }).click();
        // Settings sections nav is the stable signal that the overlay is
        // hydrated (the overlay has no level-1 heading; see
        // composer-draft-settings.spec.ts for the same anchor).
        await expect(
          app.window.getByRole("navigation", { name: "Settings sections" }),
        ).toBeVisible();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    test("thread search has no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        await expect(
          app.window.getByRole("button", { name: /Replay smoke thread/i }).first(),
        ).toBeVisible();
        // Open Search from the sidebar masthead. Before it opens, "Search
        // threads" is unambiguously the masthead button; the autofocused
        // search field (same accessible name, but role=textbox) is the
        // stable signal that the search view has mounted.
        await app.window.getByRole("button", { name: "Search threads" }).click();
        await expect(
          app.window.getByRole("textbox", { name: "Search threads" }),
        ).toBeVisible();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    test("settings → messaging has no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        await expect(
          app.window.getByRole("button", { name: /Replay smoke thread/i }).first(),
        ).toBeVisible();
        await app.window.getByRole("button", { name: "Open settings" }).click();
        await expect(
          app.window.getByRole("navigation", { name: "Settings sections" }),
        ).toBeVisible();
        await app.window
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: /^Messaging$/ })
          .click();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    test("star map layer has no violations", async () => {
      const app = await launchAuditApp({ fixturePath: STAR_MAP_FIXTURE, theme });
      try {
        await expect(
          app.window
            .getByRole("button", { name: /Star map attention thread/i })
            .first(),
        ).toBeVisible();
        await app.window.getByRole("button", { name: "Open Star Map" }).click();
        // `exact` because role-name matching is substring by default, and a
        // chat card's "Chat: <title>" region can match "Star Map" too.
        const starMap = app.window.getByRole("region", {
          name: "Star Map",
          exact: true,
        });
        await expect(starMap).toBeVisible();
        // A single E2E instance means one body on the map. Gate on a card
        // rather than the body: the lane populates from the navigation
        // snapshot after the layer mounts, and auditing the empty layer
        // would silently skip every card-borne contrast pair.
        await expect(
          starMap.getByRole("button", {
            name: "Open thread: Star map attention thread",
          }),
        ).toBeVisible();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });

    test("star map intake dialog has no violations", async () => {
      const app = await launchAuditApp({ fixturePath: STAR_MAP_FIXTURE, theme });
      try {
        await expect(
          app.window
            .getByRole("button", { name: /Star map attention thread/i })
            .first(),
        ).toBeVisible();
        await app.window.getByRole("button", { name: "Open Star Map" }).click();
        // `exact` because role-name matching is substring by default, and a
        // chat card's "Chat: <title>" region can match "Star Map" too.
        const starMap = app.window.getByRole("region", {
          name: "Star Map",
          exact: true,
        });
        await expect(starMap).toBeVisible();
        // The [+] beside the local body carries the machine label, which is
        // the runner's hostname — match the copy, not the machine.
        await starMap.getByRole("button", { name: /^New thread on / }).click();
        const intake = app.window.getByRole("dialog", {
          name: /^New thread on /,
        });
        await expect(intake).toBeVisible();
        await expect(
          intake.getByRole("button", { name: "Start thread" }),
        ).toBeVisible();
        await runAxe(app.window);
      } finally {
        await app.close();
      }
    });
  });
}
