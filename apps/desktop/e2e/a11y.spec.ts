// Renderer accessibility gate. Runs axe-core via @axe-core/playwright
// against a handful of high-traffic UI surfaces inside a real Electron
// launch (the same fixture/replay harness every other e2e spec uses),
// and asserts zero WCAG 2.0/2.1/2.2 AA violations.
//
// We intentionally use the actual Electron renderer (not a jsdom render
// of individual components) so that real styling from app.css — focus
// rings, contrast, sticky-header layout — gets audited as it actually
// ships. Surfaces that share a fixture and theme reuse one Electron
// launch, with named steps and explicit state resets keeping failures
// attributable and preventing overlays from leaking into the next scan.
// The coverage is what a screen-reader / keyboard-only operator actually
// encounters.
//
// To extend: add a named `test.step(...)` to the matching fixture group,
// or add a grouped `test(...)` when the surface needs a different fixture.
// Drive the renderer into the state, call `runAxe(window, surface)`, and
// reset any stateful layer before the next step. Launch via
// `launchAuditApp({ theme })` so every surface is audited at rest (see below).
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
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import {
  buildAuditSubAgents,
  seedThreadSubAgents,
} from "./fixtures/sub-agent-state-seeding";

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
  surface: string,
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
      `axe-core found ${results.violations.length} WCAG2 AA violation(s) on ${surface}:\n${summary}`,
    );
  }
}

for (const theme of AUDIT_THEMES) {
  test.describe(`desktop renderer accessibility (WCAG2 AA, ${theme} theme)`, () => {
    test("smoke fixture surfaces have no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        const smokeThread = app.window
          .getByRole("button", { name: /Replay smoke thread/i })
          .first();

        await test.step("sidebar + empty-thread shell", async () => {
          // The thread row is the proxy for "renderer has hydrated".
          await expect(smokeThread).toBeVisible();
          await runAxe(app.window, "sidebar + empty-thread shell");
        });

        await test.step("thread search", async () => {
          // Before Search opens, the accessible name unambiguously belongs
          // to the masthead button. The same name then moves to the
          // autofocused textbox when the search view mounts.
          await app.window
            .getByRole("button", { name: "Search threads" })
            .click();
          const searchInput = app.window.getByRole("textbox", {
            name: "Search threads",
          });
          await expect(searchInput).toBeVisible();
          await runAxe(app.window, "thread search");

          // Search is stateful main-view navigation. Close it before the
          // settings scans so their unscoped audits see the empty shell
          // behind the overlay, matching a clean launch.
          await searchInput.press("Escape");
          await expect(searchInput).toBeHidden();
          await expect(smokeThread).toBeVisible();
        });

        await test.step("settings overlay", async () => {
          await app.window.getByRole("button", { name: "Open settings" }).click();
          const settingsNav = app.window.getByRole("navigation", {
            name: "Settings sections",
          });
          await expect(settingsNav).toBeVisible();
          await runAxe(app.window, "settings overlay");

          await settingsNav
            .getByRole("button", { name: /Exit Settings/i })
            .click();
          await expect(settingsNav).toBeHidden();
          await expect(smokeThread).toBeVisible();
        });

        await test.step("settings → messaging", async () => {
          await app.window.getByRole("button", { name: "Open settings" }).click();
          const settingsNav = app.window.getByRole("navigation", {
            name: "Settings sections",
          });
          await expect(settingsNav).toBeVisible();
          await settingsNav
            .getByRole("button", { name: /^Messaging$/ })
            .click();
          const messagingSettings = app.window.getByRole("region", {
            name: "Messaging settings",
          });
          await expect(messagingSettings).toBeVisible();
          await runAxe(app.window, "settings → messaging");

          await settingsNav
            .getByRole("button", { name: /Exit Settings/i })
            .click();
          await expect(messagingSettings).toBeHidden();
          await expect(settingsNav).toBeHidden();
          await expect(smokeThread).toBeVisible();
        });

        await test.step("open thread view", async () => {
          await smokeThread.click();
          await expect(
            app.window.getByRole("heading", {
              level: 2,
              name: "Replay smoke thread",
            }),
          ).toBeVisible();
          await expect(
            app.window.getByText("The replay harness is live."),
          ).toBeVisible();
          // The celestial watermark is a real theme-dependent compositing
          // input to every contrast pair in the transcript. Keep this
          // assertion so the audit cannot go green by ceasing to render it.
          await expect(
            app.window.locator(".thread-view__primary .celestial-watermark"),
          ).toHaveCount(1);
          await runAxe(app.window, "open thread view");
        });

        // The unsent-draft chip is the one row chip that paints no
        // background of its own — it is `background: transparent` with a
        // dashed border, so unlike every other chip its contrast pair is
        // whatever surface happens to sit behind the row (default, hover,
        // selected). Nothing else in this gate renders it, because a draft
        // only exists once something has been typed. Keep this step last:
        // it deliberately leaves composer text behind.
        await test.step("thread row carrying an unsent draft", async () => {
          await app.window
            .getByRole("textbox", { name: "Reply" })
            .fill("Half-written reply the operator has not sent.");
          await expect(
            app.window.getByRole("img", { name: "Unsent draft" }).first(),
          ).toBeVisible();
          await runAxe(app.window, "thread row carrying an unsent draft");
        });
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
    // Its own fixture, deliberately: borrowing another spec's would work
    // too, but this gate's coverage would then hinge on a file it does not
    // own — drop a directory there and this block goes quiet with no
    // failure anywhere. Keeping the scan UNSCOPED matters for the same
    // reason; narrowing it with `include` is the cheap way out and would
    // stop this block catching anything outside the sidebar.
    test("sidebar copy-chip fixture surface has no violations", async () => {
      const app = await launchAuditApp({
        theme,
        fixturePath: COPY_CHIP_FIXTURE,
      });
      try {
        await test.step("sidebar rows carrying copy chips", async () => {
          // The branch chip renders last of the row's copy chips, so waiting
          // on it means the linked-directory chips are up too.
          await expect(
            app.window.getByRole("button", {
              name: "Copy branch feature/copy-chip-audit",
            }),
          ).toBeVisible();
          await runAxe(app.window, "sidebar rows carrying copy chips");
        });
      } finally {
        await app.close();
      }
    });

    // The active sub-agents strip above the composer. Nothing else in this
    // gate renders it: it only appears when a thread has a non-terminal
    // sub-agent or an undismissed failure, and no fixture produces one.
    //
    // It carries contrast pairs nothing else does — the `--status-*` dots, the
    // `--danger-text` "Failed" cell, the neutral count pill, and two row
    // controls sized right at the WCAG 2.2 target floor — so it went unaudited
    // in both themes for as long as it shipped without this block.
    //
    // No dedicated replay fixture, unlike the copy-chip block: the surface's
    // data comes from the sqlite seeder rather than the fixture, so a private
    // fixture would be a file containing nothing this test depends on. What it
    // does need from the smoke fixture — a thread that exists and opens — is
    // exactly what that fixture guarantees for every other block here.
    test("active sub-agents strip has no violations", async () => {
      const app = await launchAuditApp({ theme });
      try {
        seedThreadSubAgents({
          stateDbPath: stateDbPathForHomeRoot(app.homeRoot),
          subAgents: buildAuditSubAgents(),
          threadId: "thread-smoke",
        });
        // The renderer does not re-poll on a direct sqlite mutation.
        await app.window.reload();

        const smokeThread = app.window
          .getByRole("button", { name: /Replay smoke thread/i })
          .first();
        await expect(smokeThread).toBeVisible();
        await smokeThread.click();

        // Four rows seeds the disclosure collapsed, so the header audits
        // first and the list is opened deliberately below.
        const strip = app.window.getByRole("button", {
          name: /^Active sub-agents \(2\), 2 failed$/,
        });

        await test.step("sub-agents strip header", async () => {
          await expect(strip).toBeVisible();
          await expect(strip).toHaveAttribute("aria-expanded", "false");
          // Bulk dismiss only renders past one failure; assert it is painted
          // so the audit cannot go quiet by the seed drifting to a single one.
          await expect(
            app.window.getByRole("button", {
              name: "Dismiss all 2 failed sub-agents",
            }),
          ).toBeVisible();
          await runAxe(app.window, "sub-agents strip header");
        });

        await test.step("sub-agents strip expanded rows", async () => {
          await strip.click();
          await expect(strip).toHaveAttribute("aria-expanded", "true");
          // One assertion per row branch. Without these the scan still passes
          // on an empty list and stops auditing the states it exists for.
          await expect(
            app.window.getByRole("button", {
              name: /^Stop sub-agent: Run and monitor/,
            }),
          ).toBeVisible();
          // Exact: `getByText` matches substrings, and "Blocked on approval"
          // is sanctioned copy elsewhere in the style guide.
          await expect(
            app.window.getByText("Blocked", { exact: true }),
          ).toBeVisible();
          await expect(
            app.window.getByRole("button", {
              name: /^Dismiss failed sub-agent: Build and verify/,
            }),
          ).toBeVisible();
          await expect(app.window.locator(".live-strip__item")).toHaveCount(4);
          await runAxe(app.window, "sub-agents strip expanded rows");
        });
      } finally {
        await app.close();
      }
    });

    // The smoke fixture group opens an idle thread, so its transcript
    // renders nothing but its `role="listitem"` entries.
    // An ACTIVE thread additionally renders `.transcript-list__pending`,
    // the `role="status"` thinking line — and role="status" is not a
    // permitted owned element of the `role="list"` scroll container, so
    // for as long as it sat there bare every active thread failed
    // `aria-required-children` (critical) with nothing to catch it: the
    // idle fixture never renders the live region, and the Star Map blocks
    // do use an active fixture but the map layer covers the thread view.
    // It now renders inside a listitem wrapper. This block is the gate on
    // that, so keep the fixture active and the scan unscoped.
    test("star map fixture surfaces have no violations", async () => {
      const app = await launchAuditApp({ fixturePath: STAR_MAP_FIXTURE, theme });
      try {
        const attentionThread = app.window
          .getByRole("button", { name: /Star map attention thread/i })
          .first();
        const starMap = app.window.getByRole("region", {
          name: "Star Map",
          exact: true,
        });
        const starMapCard = starMap.getByRole("button", {
          name: "Open thread: Star map attention thread",
        });

        await test.step("star map layer", async () => {
          await expect(attentionThread).toBeVisible();
          await app.window.getByRole("button", { name: "Open Star Map" }).click();
          await expect(starMap).toBeVisible();
          // Gate on a card rather than only the map body: the lane populates
          // after the layer mounts, and an empty map skips the card contrast.
          await expect(starMapCard).toBeVisible();
          await runAxe(app.window, "star map layer");

          await starMap
            .getByRole("button", { name: "Close Star Map" })
            .click();
          await expect(starMap).toHaveCount(0);
          await expect(
            app.window.getByRole("button", { name: "Open Star Map" }),
          ).toBeVisible();
        });

        await test.step("star map intake dialog", async () => {
          await expect(
            app.window.getByRole("button", { name: "Open Star Map" }),
          ).toBeVisible();
          await app.window.getByRole("button", { name: "Open Star Map" }).click();
          await expect(starMap).toBeVisible();
          await expect(starMapCard).toBeVisible();
          // The [+] beside the local body carries the runner hostname, so
          // match the stable copy rather than a machine-specific label.
          await starMap.getByRole("button", { name: /^New thread on / }).click();
          const intake = app.window.getByRole("dialog", {
            name: /^New thread on /,
          });
          await expect(intake).toBeVisible();
          await expect(
            intake.getByRole("button", { name: "Start thread" }),
          ).toBeVisible();
          await runAxe(app.window, "star map intake dialog");

          await intake
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(intake).toHaveCount(0);
          await starMap
            .getByRole("button", { name: "Close Star Map" })
            .click();
          await expect(starMap).toHaveCount(0);
          await expect(attentionThread).toBeVisible();
        });

        await test.step("open thread view with an active thread", async () => {
          await attentionThread.click();
          await expect(app.window.getByText("The star map is live.")).toBeVisible();
          // Assert the live region is actually painted. Without this the
          // scan keeps passing if the fixture stops being active and quietly
          // stops auditing the role=status/list relationship it exists for.
          await expect(
            app.window.locator(".transcript-list__pending"),
          ).toHaveCount(1);
          await runAxe(app.window, "open thread view with an active thread");
        });
      } finally {
        await app.close();
      }
    });
  });
}
