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
// `launchAuditApp()` so the surface is audited at rest (see below).
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
// That fixture's threads deliberately carry NO linked directories. A
// project chip renders through `CopyableThreadChip`, which is a
// `role="button" tabIndex={0}` span, and both the sidebar thread row and
// the star-map card wrap their content in a real `<button>` — so any
// fixture with a directory trips `nested-interactive` on BOTH surfaces.
// That is pre-existing renderer debt, not a Star Map regression, and the
// fix is a structural change to the row/card (hoist the chips out of the
// button, the way `.star-map-card-shell` already hoists the kebab).
// Waiving it here is not an option worth taking: `KNOWN_VIOLATIONS`
// works by `exclude()`, so waiving the rule would drop the whole card
// from the scan and blind the very contrast pairs this block exists to
// audit. Tracked separately; when it lands, give these threads a
// directory so the project chip is covered too.
const STAR_MAP_FIXTURE = path.resolve(
  specDir,
  "fixtures/star-map/replay.fixture.json",
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
     * nobody thought to point at.
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

test.describe("desktop renderer accessibility (WCAG2 AA)", () => {
  test("sidebar + empty-thread shell has no violations", async () => {
    const app = await launchAuditApp();
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

  test("open thread view has no violations", async () => {
    const app = await launchAuditApp();
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
      await runAxe(app.window);
    } finally {
      await app.close();
    }
  });

  test("settings overlay has no violations", async () => {
    const app = await launchAuditApp();
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
    const app = await launchAuditApp();
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
    const app = await launchAuditApp();
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
    const app = await launchAuditApp({ fixturePath: STAR_MAP_FIXTURE });
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
    const app = await launchAuditApp({ fixturePath: STAR_MAP_FIXTURE });
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

  // The celestial watermark paints the owning instance's mark behind the
  // transcript at 0.05 opacity. That is a real compositing input to every
  // contrast pair in the thread body, and the token it tints with
  // (`--text-muted`) resolves differently per theme — a value that is
  // harmless behind a dark surface can eat the margin on a light one. So
  // this pair of blocks audits the same surface twice, once per theme,
  // and asserts the watermark is actually painted first: without that the
  // audit would keep passing after a regression that stopped rendering it.
  //
  // Scoped to `.thread-view__primary` — the element the watermark is a
  // child of, and therefore the exact subtree it composites into. The
  // scope is what makes the LIGHT run meaningful rather than a proxy for
  // unrelated debt: light theme is not AA-clean window-wide today (the
  // sidebar wordmark accent lands at 4.2:1, the active lens-switch label
  // at 3.17:1, and the context-grid `dt` labels at 4.23:1), none of which
  // the watermark touches. Every other block in this file stays unscoped;
  // the dark thread surface is already audited whole by "open thread view
  // has no violations" above.
  for (const theme of ["dark", "light"] as const) {
    test(`thread transcript behind the celestial watermark has no violations (${theme})`, async () => {
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
        await expect(
          app.window.getByText("The replay harness is live."),
        ).toBeVisible();
        // aria-hidden, so it has no role to locate it by; the class IS
        // the contract the a11y note in app.css points at.
        await expect(
          app.window.locator(".thread-view__primary .celestial-watermark"),
        ).toHaveCount(1);
        await runAxe(app.window, { include: ".thread-view__primary" });
      } finally {
        await app.close();
      }
    });
  }
});
