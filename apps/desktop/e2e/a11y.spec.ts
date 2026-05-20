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
// dialog, switch a tab) and then calls `runAxe(window)`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

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

async function runAxe(window: Page): Promise<void> {
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
    const app = await launchElectronApp({
      fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    });
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
    const app = await launchElectronApp({
      fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    });
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
    const app = await launchElectronApp({
      fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    });
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

  test("settings → messaging has no violations", async () => {
    const app = await launchElectronApp({
      fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    });
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
});
