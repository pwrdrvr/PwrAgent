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
// Every surface is audited in every shipped appearance: Tangerine dark
// and light, plus each other color theme in the one scheme it renders in
// (`AUDIT_APPEARANCES` below). The gate ran dark-only for its whole life,
// which is exactly why three light-theme token-level contrast failures
// shipped unnoticed: `--accent` at 4.20:1 on the sidebar wordmark,
// `--accent-bright` at 3.17:1 on the active lens tab, and `--text-muted`
// at 4.23:1 on the .context-grid thread-info labels.
//
// Contrast is the one rule class that is genuinely theme-dependent —
// roles, names, and focus order are not. A color theme in app.css sets
// color tokens only, and no component branches on it, so work that
// cannot see color skips the extra color themes. Tangerine
// dark and light run the full WCAG AA tag set on every surface; the other
// color themes run only the color rules (`COLOR_RULES`). The composer
// autocomplete block runs in the Tangerine pair only, because
// theme-contract.test.tsx measures the popup's tokens in every theme, and
// the directories block's functional steps run in Tangerine dark only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type {
  DesktopDarkTheme,
  DesktopLightTheme,
  DesktopAppearanceTheme,
} from "@pwragent/shared/contracts/settings";
import { expect, test, type Locator, type Page } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import {
  PR_WATCH_AUDIT_UNWATCHED_PR,
  PR_WATCH_AUDIT_WATCHED_PR,
  seedPrWatchAuditState,
} from "./fixtures/pr-watch-state-seeding";
import {
  RESOURCES_AUDIT_CHANGED,
  RESOURCES_AUDIT_POOL,
  RESOURCES_AUDIT_UNREACHABLE,
  RESOURCES_AUDIT_UNRESOLVED,
  seedResourcesAuditRecovery,
  seedResourcesAuditState,
  type ResourcesAuditSeed,
} from "./fixtures/resource-checkout-seeding";
import { openStarMapWindow } from "./fixtures/star-map-window";
import { buildAuditSubAgents } from "./fixtures/sub-agent-state-seeding";
import {
  WORKTREE_STORAGE_AUDIT_LABEL,
  prepareWorktreeStorageAudit,
  seedWorktreeStorageAuditState,
} from "./fixtures/worktree-storage-seeding";
import { StateDb } from "../src/main/state/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { seedResearchState, enableResearchFixture, readResearchOwnerIdentity, seedLiveResearchRun, seedLongResearchRun, LONG_RESEARCH_OBJECTIVE } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Lane balance only. `workers: 1` still runs these one at a time, in order;
// `parallel` makes each test its own shard group so CI's weighted
// `--shard` can split this file across lanes (see the desktop-e2e job in
// .github/workflows/ci.yml). Every test launches its own app, so no state
// crosses a test boundary.
test.describe.configure({ mode: "parallel" });

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
  /** Default to the harness defaults (the Tangerine pair). */
  darkTheme?: DesktopDarkTheme;
  lightTheme?: DesktopLightTheme;
  /**
   * Seed overlay state into the profile before boot. Prefer this to seeding
   * after launch and reloading — the renderer does not re-poll on a direct
   * sqlite mutation, so a post-launch seed costs a full renderer reload per
   * theme. `StateDb.open` creates the profile directory, so the hook can run
   * before anything else has.
   */
  preLaunchHook?: (homeRoot: string) => Promise<void>;
  /** Launch environment overrides; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
}) {
  const app = await launchElectronApp({
    fixturePath:
      options?.fixturePath
      ?? path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    ...(options?.theme || options?.darkTheme || options?.lightTheme
      ? {
          appearance: {
            theme: options.theme,
            darkTheme: options.darkTheme,
            lightTheme: options.lightTheme,
          },
        }
      : {}),
    ...(options?.preLaunchHook
      ? { preLaunchHook: options.preLaunchHook }
      : {}),
    ...(options?.env ? { env: options.env } : {}),
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
// threads are `threadStatus: "active"` and therefore reach the map in
// every lens (orbit clouds by default, lanes/projects when chosen).
//
// Both schemes ship, so both are gated. See the header note.
// `as const`, not `readonly DesktopAppearanceTheme[]` — that type also
// admits "system", which resolves through the OS and lands on light on
// most Linux runners (see the note on `appearance` in
// fixtures/electron-app.ts). Pinning the literals keeps a
// nondeterministic third entry from typechecking its way in.
const AUDIT_THEMES = ["dark", "light"] as const satisfies readonly DesktopAppearanceTheme[];

// Every color theme ships, so every color theme is gated, each in the one
// scheme it renders in. Catppuccin is tuned to sit just above the AA floor
// on purpose, and Solarized is moved off its canonical text only as far as
// AA needs, which makes them the themes most likely to slip under it.
const AUDIT_DARK_THEMES = [
  "catppuccin-mocha",
  "solarized-dark",
  "gray-dark",
  "blue-dark",
  "phosphor-dark",
] as const satisfies readonly DesktopDarkTheme[];
const AUDIT_LIGHT_THEMES = [
  "catppuccin-latte",
  "solarized-light",
  "gray-light",
  "blue-light",
] as const satisfies readonly DesktopLightTheme[];
type AuditAppearance = {
  theme: (typeof AUDIT_THEMES)[number];
  /** Absent for the Tangerine pair, which keeps its original titles. */
  colorTheme?: string;
  darkTheme?: DesktopDarkTheme;
  lightTheme?: DesktopLightTheme;
};
const AUDIT_APPEARANCES: AuditAppearance[] = [
  ...AUDIT_THEMES.map((theme) => ({ theme })),
  ...AUDIT_DARK_THEMES.map((darkTheme) => ({
    theme: "dark" as const,
    colorTheme: darkTheme,
    darkTheme,
  })),
  ...AUDIT_LIGHT_THEMES.map((lightTheme) => ({
    theme: "light" as const,
    colorTheme: lightTheme,
    lightTheme,
  })),
];

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

const COMPOSER_AUTOCOMPLETE_FIXTURE = path.resolve(
  specDir,
  "fixtures/skill-autocomplete-interactions/replay.fixture.json",
);

// One thread on an invented GitHub repository, with no linked directory, so
// its PRs are primary (Auto-fix and Watch CI apply) and no branch lookup runs.
// The PRs and watches come from sqlite; see the block.
const PR_WATCHES_FIXTURE = path.resolve(
  specDir,
  "fixtures/a11y-pr-watches/replay.fixture.json",
);

// The block's PRs are invented, so a real forge call can only fail. Without a
// token the status poller's `gh` call fails before it reaches the network.
const NO_FORGE_CREDENTIALS = {
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
  GITLAB_TOKEN: undefined,
};

// Fourteen threads on one directory and one on a second, so the audited row
// has a pinned lane, an unpinned lane that overflows the ten-row cap, and a
// collapsed sibling row. The pins themselves come from sqlite — see the block.
const DIRECTORIES_FIXTURE = path.resolve(
  specDir,
  "fixtures/a11y-directories/replay.fixture.json",
);

// The two threads the block pins, both on the audited directory. They are the
// fixture's first two, so the pinned lane keeps the order the file lists.
const DIRECTORIES_PINNED_THREAD_IDS = [
  "thread-directories-01",
  "thread-directories-02",
];

const WCAG_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
];

// The axe rules that read color. A color theme sets color tokens only, so
// these are the only rules whose result can differ from Tangerine in the
// same scheme. Measured on a Linux sandbox, a scan limited to them took
// ~250ms against ~390ms for the full tag set.
const COLOR_RULES = ["color-contrast", "link-in-text-block"];

// Selectors waived from the axe scan, with a written reason. Every
// earlier waiver was fixed in the renderer. If a new pre-existing
// violation surfaces (e.g. on a new surface added to the suite below) and
// is too invasive to fix in the same PR, add an entry here so the gate
// stays green AND surfaces the debt, then file a follow-up.
const KNOWN_VIOLATIONS: ReadonlyArray<{
  selector: string;
  rule: string;
  reason: string;
}> = [];

/**
 * Direct `listitem` children of a list. `Locator.getByRole` matches every
 * descendant, so a nested list's rows would be counted as though they were the
 * outer list's own.
 */
function listItems(list: Locator): Locator {
  return list.locator("> [role=listitem]");
}

/** One violating node, as `AxeBuilder.analyze()` reports it. */
type AxeViolationNode =
  Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number]["nodes"][number];

/**
 * The measurement behind one violating node, for the CI log.
 *
 * A rule's `help` states the requirement; only the node's own check results
 * carry the value that failed it, and for several rules the requirement alone
 * cannot be acted on. `target-size` is the worked example: "24px by 20px,
 * should be at least 24px by 24px" is a box to grow, while "insufficient space
 * to its closest neighbors" is a margin to add and "partially obscured" is a
 * z-order overlap — three different fixes behind one sentence of help text.
 * The Windows lane spent a cycle guessing between them.
 *
 * `html` comes along because a `target` selector is built from whatever
 * attributes make the node unique, so it is often an `aria-label` with no hint
 * of which component drew the element. Truncated: axe returns the full outer
 * HTML, and a row with children can run for thousands of characters.
 */
function describeNode(node: AxeViolationNode): string {
  const reasons = [...node.any, ...node.all, ...node.none].map(
    (check) => check.message,
  );
  const lines = [...new Set(reasons)].map((reason) => `        ${reason}`);
  const html = node.html.replace(/\s+/g, " ").trim();
  lines.push(`        html: ${html.length > 200 ? `${html.slice(0, 200)}…` : html}`);
  return lines.join("\n");
}

/**
 * Name the elements sitting on top of a target, for an obscured `target-size`.
 *
 * axe reports the measurement ("315px by 8.8px") but never what took the rest.
 * Without this you are reduced to reading the stylesheet and guessing, which
 * costs a CI cycle per guess — and two of those guesses were wrong here,
 * because `pointer-events` INHERITS and a rule that looks like it silences an
 * overlapper may be a no-op on an already-silenced subtree.
 *
 * `elementsFromPoint` is the right probe because it applies the same rule axe
 * does: it omits anything with `pointer-events: none`, which is exactly the
 * filter in axe's `getTargetRects`. Everything it returns above the target is
 * therefore a real obscurer, and each one either has to stop taking the
 * pointer or stop covering the band.
 *
 * Sampled on a grid rather than at the centre: an overlapper that covers only
 * one end is what splits the rect, and the centre alone would miss it.
 */
async function describeObscurers(
  window: Page,
  selector: string,
): Promise<string> {
  const names = await window.evaluate((target) => {
    const node = document.querySelector(target);
    if (!node) {
      return [];
    }
    const rect = node.getBoundingClientRect();
    const found = new Set<string>();
    for (let row = 1; row <= 3; row += 1) {
      for (let column = 1; column <= 5; column += 1) {
        const x = rect.left + (rect.width * column) / 6;
        const y = rect.top + (rect.height * row) / 4;
        const stack = document.elementsFromPoint(x, y);
        // Only elements painted ABOVE the target obscure it. When the target
        // is not in the stack at all — fully covered, or `pointer-events:
        // none` itself — there is no "above", and taking the whole stack
        // would name the target's own ancestors, `body` and `html` as
        // obscurers and send the reader after elements that obscure nothing.
        const depth = stack.indexOf(node);
        if (depth < 0) {
          continue;
        }
        for (const element of stack.slice(0, depth)) {
          if (node.contains(element)) {
            continue;
          }
          const classes = typeof element.className === "string"
            ? element.className.trim().split(/\s+/).filter(Boolean)
            : [];
          found.add(
            `${element.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join("")}`,
          );
        }
      }
    }
    return [...found];
  }, selector);
  return names.length > 0
    ? `\n        obscured by: ${names.join(", ")}`
    : "";
}

async function runAxeScan(
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
    /** Run only the named axe rules when a regression gate is rule-specific. */
    rules?: string[];
    /** Record the result matrix for the shared-launch comparison. */
    comparisonKey?: string;
    /** Continue to audit later appearances after reporting a violation. */
    softViolations?: boolean;
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
  let builder = new AxeBuilder({ page: window }).setLegacyMode(true);
  if (options?.rules) {
    builder = builder.withRules(options.rules);
  } else {
    builder = builder.withTags(WCAG_AA_TAGS);
  }
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
  if (options?.comparisonKey) {
    const outcomes = ["passes", "violations", "incomplete", "inapplicable"] as const;
    const matrix = Object.fromEntries(outcomes.map((outcome) => [
      outcome,
      results[outcome].map(({ id, nodes }) => ({
        id,
        targets: nodes.map(({ target }) => JSON.stringify(target)).sort(),
      })).sort((left, right) => left.id.localeCompare(right.id)),
    ]));
    await test.info().attach(`axe-copy-chips-${options.comparisonKey}`, {
      body: JSON.stringify(matrix),
      contentType: "application/json",
    });
  }

  // Surface the human-readable summary on failure so the CI log tells
  // you which rules + selectors failed without having to download the
  // Playwright trace artifact.
  if (results.violations.length > 0) {
    const summary = (
      await Promise.all(
        results.violations.map(async (violation) => {
          const nodes = (
            await Promise.all(
              violation.nodes.map(async (node) => {
                const selector = node.target.join(" ");
                // Only the obscured case needs the extra probe, and only a
                // string selector can be re-queried in the page.
                const obscurers =
                  violation.id === "target-size"
                  && typeof node.target[0] === "string"
                  && node.target.length === 1
                    ? await describeObscurers(window, selector)
                    : "";
                return `    - ${selector}\n${describeNode(node)}${obscurers}`;
              }),
            )
          ).join("\n");
          return `  ${violation.id} (${violation.impact ?? "n/a"}): ${violation.help}\n${nodes}\n    ${violation.helpUrl}`;
        }),
      )
    ).join("\n");
    const message = `axe-core found ${results.violations.length} WCAG2 AA violation(s) on ${surface}:\n${summary}`;
    if (options?.softViolations) {
      expect.soft(results.violations.length, message).toBe(0);
    } else {
      throw new Error(message);
    }
  }
}

// The dedicated fixture carries a worktree chip, a local-directory chip,
// and a branch chip. Audit the whole window to catch nested-interactive
// regressions on the row that contains them.
async function scanCopyChips(page: Page, appearance: AuditAppearance): Promise<void> {
  const label = appearance.colorTheme ?? `tangerine-${appearance.theme}`;
  await test.step(`sidebar rows carrying copy chips (${label})`, async () => {
    // The branch chip renders last, after the linked-directory chips.
    await expect(page.getByRole("button", {
      name: "Copy branch feature/copy-chip-audit",
    })).toBeVisible();
    // Startup hydrates the transcript and then checks its linked checkout.
    // Wait for both before scanning the full window in either launch mode.
    await expect(page.getByText("The copy chip row is live.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "This thread’s worktree is gone" })).toBeVisible();
    await expect.poll(() => page.locator("html").evaluate((root) => ({
      scheme: root.getAttribute("data-theme"),
      colorTheme: root.getAttribute("data-color-theme"),
    }))).toEqual({
      scheme: appearance.theme === "light" ? "light" : null,
      colorTheme: appearance.colorTheme ?? null,
    });
    await runAxeScan(page, `sidebar rows carrying copy chips (${label})`, {
      rules: appearance.colorTheme ? COLOR_RULES : undefined,
      comparisonKey: label,
      softViolations: true,
    });
  });
}

// The copy-chip scenario never interacts with the sidebar. Each appearance
// can therefore scan the same hydrated surface after the settings broadcast.
// This switch runs the exact same scans with one fresh launch per appearance
// when collecting a native comparison.
const freshCopyChipLaunches = process.env.PWRAGENT_E2E_A11Y_FRESH_COPY_CHIPS === "1";
const copyChipGroups = freshCopyChipLaunches
  ? AUDIT_APPEARANCES.map((appearance) => [appearance])
  : [AUDIT_APPEARANCES];
for (const appearances of copyChipGroups) {
  const initial = appearances[0]!;
  const title = freshCopyChipLaunches
    ? initial.colorTheme ?? `tangerine-${initial.theme}`
    : "all appearances";
  test(`sidebar copy-chip fixture surface has no violations (${title})`, async () => {
    const app = await test.step("launch copy-chip fixture", () =>
      launchAuditApp({ ...initial, fixturePath: COPY_CHIP_FIXTURE }));
    try {
      await scanCopyChips(app.window, initial);
      for (const appearance of appearances.slice(1)) {
        await app.window.evaluate(async ({ theme, darkTheme, lightTheme }) => {
          const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
          await api.writeSettingsConfig!({
            patch: {
              general: {
                appearance: {
                  theme,
                  darkTheme: darkTheme ?? "tangerine-dark",
                  lightTheme: lightTheme ?? "tangerine-light",
                },
              },
            },
          });
        }, appearance);
        await scanCopyChips(app.window, appearance);
      }
    } finally {
      await test.step("close copy-chip fixture", () => app.close());
    }
  });
}

for (const { colorTheme, darkTheme, lightTheme, theme } of AUDIT_APPEARANCES) {
  // Tangerine keeps its original titles so its results stay comparable.
  const colorThemeLabel = colorTheme ? `, ${colorTheme}` : "";
  const appearance = { theme, darkTheme, lightTheme };
  // Behavior checks that ride along with an audit and read no color run in
  // one appearance only. Tangerine dark is the harness default.
  const runsFunctionalChecks = !colorTheme && theme === "dark";
  // Tangerine dark and light run the full WCAG AA tag set on every surface.
  // The other color themes run only the color rules there: every other rule
  // sees the same DOM and geometry as Tangerine in the same scheme. A block
  // that passes its own `rules` keeps them.
  const runAxe = (
    page: Page,
    surface: string,
    options?: Parameters<typeof runAxeScan>[2],
  ) =>
    runAxeScan(page, surface, {
      ...options,
      rules: options?.rules ?? (colorTheme ? COLOR_RULES : undefined),
    });
  test.describe(`desktop renderer accessibility (WCAG2 AA, ${theme} theme${colorThemeLabel})`, () => {
    test("Job Monitors composer options have no violations", async () => {
      const app = await launchAuditApp(appearance);
      try {
        await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
        const trigger = app.window.getByRole("button", { name: "Thread options", exact: true });
        await trigger.click();
        const menu = app.window.getByRole("menu", { name: "Thread options", exact: true });
        const monitors = menu.getByRole("menuitemcheckbox", { name: "Job Monitors", exact: true });
        const include = ".composer-thread-options__menu";
        await expect(monitors).toHaveAttribute("aria-checked", "true");
        const mcpAccess = menu.getByRole("menuitem", { name: /^PwrAgent MCPs/ });
        await expect(mcpAccess).toContainText("none selected");
        await mcpAccess.hover();
        await runAxe(app.window, "Job Monitors on", { include });
        await monitors.click();
        await expect(monitors).toHaveAttribute("aria-checked", "false");
        await expect(monitors).not.toHaveAttribute("aria-busy", "true");
        await expect(monitors).toContainText("The agent can't start new ones.");
        const suggestions = menu.getByRole("menuitemcheckbox", { name: "Monitor job suggestions", exact: true });
        await expect(suggestions).toHaveAttribute("aria-disabled", "true");
        await expect(suggestions).toContainText("needs Job Monitors");
        await runAxe(app.window, "Job Monitors off", { include });
        await monitors.press("ArrowDown");
        await expect(suggestions).toBeFocused();
        await app.window.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      } finally {
        await app.close();
      }
    });

    test("smoke fixture surfaces have no violations", async () => {
      const app = await launchAuditApp(appearance);
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
          // autofocused combobox when the search view mounts.
          await app.window
            .getByRole("button", { name: "Search threads" })
            .click();
          const searchInput = app.window.getByRole("combobox", {
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

        // The four-tile release matrix is the densest ARIA surface in
        // Settings — a radiogroup with a roving tabindex, an arrow-key
        // walk, and two status chips whose contrast is theme-dependent. It
        // used to ride along in the "settings overlay" scan because it was
        // a card inside General; moving it to its own nav row took it out
        // of every audit, so it gets its own step.
        await test.step("settings → updates", async () => {
          await app.window.getByRole("button", { name: "Open settings" }).click();
          const settingsNav = app.window.getByRole("navigation", {
            name: "Settings sections",
          });
          await expect(settingsNav).toBeVisible();
          await settingsNav
            .getByRole("button", { name: /^Updates$/ })
            .click();
          const updateSettings = app.window.getByRole("region", {
            name: "Update settings",
          });
          await expect(updateSettings).toBeVisible();
          // The tiles render before any release data lands, falling through
          // to "Unavailable", so the audit never waits on the network.
          await expect(
            app.window.getByRole("radiogroup", { name: "Release channel" }),
          ).toBeVisible();
          await runAxe(app.window, "settings → updates");

          await settingsNav
            .getByRole("button", { name: /Exit Settings/i })
            .click();
          await expect(updateSettings).toBeHidden();
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

        await test.step("settings → profiles → guided Codex profile setup", async () => {
          await app.window.getByRole("button", { name: "Open settings" }).click();
          const settingsNav = app.window.getByRole("navigation", {
            name: "Settings sections",
          });
          await expect(settingsNav).toBeVisible();
          await settingsNav
            .getByRole("button", { name: /^Profiles$/ })
            .click();
          await app.window
            .getByRole("region", { name: "Profile settings" })
            .getByRole("button", { name: "Add a Codex profile" })
            .click();
          const guided = app.window.getByRole("dialog", {
            name: "Add a Codex profile",
          });
          await expect(guided).toBeVisible();
          await runAxe(app.window, "settings → profiles → add a Codex profile");

          await app.window.keyboard.press("Escape");
          await expect(guided).toBeHidden();
          await settingsNav
            .getByRole("button", { name: /Exit Settings/i })
            .click();
          await expect(settingsNav).toBeHidden();
          await expect(smokeThread).toBeVisible();
        });

        // Key caps, a recorder that swallows keys, and per-row notices: its
        // own surface, so its own scan, with the recorder open.
        await test.step("settings → keyboard", async () => {
          await app.window.getByRole("button", { name: "Open settings" }).click();
          const settingsNav = app.window.getByRole("navigation", {
            name: "Settings sections",
          });
          await expect(settingsNav).toBeVisible();
          await settingsNav
            .getByRole("button", { name: /^Keyboard$/ })
            .click();
          const keyboardSettings = app.window.getByRole("region", {
            name: "Keyboard shortcuts",
          });
          await expect(keyboardSettings).toBeVisible();
          await keyboardSettings
            .getByRole("button", { name: "Change Pin / Unpin" })
            .click();
          await expect(
            keyboardSettings.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" }),
          ).toBeFocused();
          await runAxe(app.window, "settings → keyboard");

          await keyboardSettings.getByRole("button", { name: "Cancel" }).click();
          await settingsNav
            .getByRole("button", { name: /Exit Settings/i })
            .click();
          await expect(keyboardSettings).toBeHidden();
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
      const app = await launchAuditApp(appearance);
      try {
        // The backend's listThreads waits for startup reconciliation. Seed
        // live fixture cards after it finishes so it cannot mark them orphaned.
        await app.window.evaluate(async () => {
          const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
          await api.listThreads!({ backend: "codex" });
        });
        const stateDb = StateDb.open(stateDbPathForHomeRoot(app.homeRoot), { profileName: "default" });
        try {
          await new SqliteOverlayStore(stateDb).upsertThreadSubAgents({
            backend: "codex",
            subAgents: buildAuditSubAgents(),
            threadId: "thread-smoke",
          });
        } finally {
          stateDb.close();
        }
        // The renderer does not re-poll after a direct database write.
        await app.window.reload();

        const smokeThread = app.window
          .getByRole("button", { name: /Replay smoke thread/i })
          .first();
        await expect(smokeThread).toBeVisible();
        await smokeThread.click();

        // Four rows seeds the disclosure collapsed, so the header audits
        // first and the list is opened deliberately below.
        const strip = app.window.getByRole("button", {
          name: /^Active sub-agents, 2, 2 failed$/,
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

    // Resources: the list with a row expanded, the inspector in each state the
    // real authority reaches, and each dialog it can open. The state enters
    // through the authorities file and the main-process checkout service on the
    // app's own stores (fixtures/resource-checkout-seeding.ts): an agent holds
    // a counted pool with another waiting, a Federation peer is unreachable,
    // a binding copied from another machine leaves ownership unresolved with
    // only a remedy, and a hosted resource whose configured epoch changed
    // offers to accept the new definition. Recovery is seeded after launch,
    // once the operator's own hold is released, and the pending draft comes
    // from the Register dialog itself.
    //
    // Not reachable, so not audited: Needs interactive session (no authority
    // reports readiness).
    test("Resources checkout surfaces have no violations", async () => {
      // Fourteen unscoped scans plus a launch.
      test.setTimeout(150_000);
      let seed: ResourcesAuditSeed | undefined;
      const app = await launchAuditApp({
        ...appearance,
        preLaunchHook: async (homeRoot) => {
          seed = await seedResourcesAuditState(homeRoot);
        },
      });
      try {
        const mainWindow = app.window;
        const profile = mainWindow.getByRole("button", { name: /^Open PwrAgent profile menu:/ });
        await profile.click();
        const opened = app.electronApp.waitForEvent("window");
        await mainWindow.getByTestId("profile-menu-resources").click();
        const window = await opened;
        const resources = window.getByRole("region", { name: "Resources", exact: true });
        const row = (resourceId: string) => resources.locator(`li[data-resource-id="${resourceId}"]`);
        const chip = (resourceId: string, condition: string) =>
          row(resourceId).locator(`.resources-chip[data-condition="${condition}"]`);
        const inspectorFor = (displayName: string) =>
          resources.getByRole("complementary", { name: displayName, exact: true });
        // The row's select button starts with the name; its toggle reads
        // "Show routes for …", and no other control starts with a name.
        const select = async (displayName: string) => {
          const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          await resources.getByRole("button", { name: new RegExp(`^${escaped} `) }).click();
          const inspector = inspectorFor(displayName);
          await expect(inspector).toBeVisible();
          return inspector;
        };
        // Focus enters the dialog, Escape closes it, and focus returns to
        // the control that opened it. Behavior only, so one appearance.
        const checkDialogKeyboard = async (opener: Locator, dialog: Locator) => {
          await opener.click();
          await expect(dialog).toBeVisible();
          if (!runsFunctionalChecks) {
            return;
          }
          await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
          await window.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
          await expect(opener).toBeFocused();
          await opener.click();
          await expect(dialog).toBeVisible();
        };
        const machineId = seed!.machineResourceId;

        await test.step("resource list with a row expanded", async () => {
          // One assertion per seeded state, so a drifted seed cannot leave
          // the scan auditing fewer rows than it claims.
          await expect(chip(machineId, "available")).toBeVisible();
          await expect(chip(RESOURCES_AUDIT_POOL.resourceId, "busy")).toHaveText("1 of 4 free");
          await expect(chip(RESOURCES_AUDIT_UNREACHABLE.resourceId, "unreachable")).toBeVisible();
          await expect(chip(RESOURCES_AUDIT_UNRESOLVED.resourceId, "ownership_unresolved")).toBeVisible();
          await expect(chip(RESOURCES_AUDIT_CHANGED.resourceId, "ownership_unresolved")).toBeVisible();
          const toggle = row(machineId).getByRole("button", { name: "Show routes for This machine", exact: true });
          await toggle.click();
          await expect(row(machineId).getByRole("button", { name: "Hide routes for This machine", exact: true }))
            .toHaveAttribute("aria-expanded", "true");
          await expect(row(machineId).getByText("Execution routes", { exact: true })).toBeVisible();
          await expect(row(machineId).getByText("Local process", { exact: true })).toBeVisible();
          await runAxe(window, "Resources list with a row expanded");
        });

        await test.step("inspector: counted pool held by an agent with a queue", async () => {
          const inspector = await select(RESOURCES_AUDIT_POOL.displayName);
          await expect(inspector.getByRole("button", { name: "Agent thread", exact: true }).first()).toBeVisible();
          await expect(inspector.locator(".resources-queue > li")).toHaveCount(1);
          await expect(inspector.getByText("Render jobs only. Free slots before ending the turn.", { exact: true }))
            .toBeVisible();
          await runAxe(window, "Resources inspector, busy counted pool");
        });

        await test.step("Join queue dialog", async () => {
          const inspector = inspectorFor(RESOURCES_AUDIT_POOL.displayName);
          const opener = inspector.getByTestId("resources-action-request");
          await expect(opener).toHaveText("Join queue");
          const dialog = window.getByRole("dialog", { name: `Join queue: ${RESOURCES_AUDIT_POOL.displayName}`, exact: true });
          await checkDialogKeyboard(opener, dialog);
          await dialog.getByRole("textbox", { name: "Purpose", exact: true }).fill("Accessibility audit render");
          const units = dialog.getByRole("spinbutton", { name: "Units", exact: true });
          await expect(units).toBeVisible();
          // Request 2 of 4 slots (only 1 is free) so EASY backfilling queues it
          // instead of granting it immediately, exercising the queued-request state.
          await units.fill("2");
          await runAxe(window, "Join queue dialog");
          await dialog.getByRole("button", { name: "Join queue", exact: true }).click();
          await expect(dialog).toBeHidden();
        });

        await test.step("inspector: your own queued request", async () => {
          const inspector = inspectorFor(RESOURCES_AUDIT_POOL.displayName);
          await expect(inspector.locator(".resources-queue > li.is-mine")).toHaveCount(1);
          const cancel = inspector.getByTestId("resources-action-cancel_request");
          await expect(cancel).toBeVisible();
          await runAxe(window, "Resources inspector, queued request");
          await cancel.click();
          await expect(inspector.getByTestId("resources-action-request")).toBeVisible();
          await expect(inspector.locator(".resources-queue > li")).toHaveCount(1);
        });

        await test.step("inspector: unreachable authority", async () => {
          const inspector = await select(RESOURCES_AUDIT_UNREACHABLE.displayName);
          await expect(inspector.getByRole("note")).toContainText("unreachable");
          await runAxe(window, "Resources inspector, unreachable authority");
        });

        await test.step("inspector: ownership unresolved", async () => {
          const inspector = await select(RESOURCES_AUDIT_UNRESOLVED.displayName);
          await expect(inspector.getByRole("note")).toContainText("Ownership unresolved");
          // The binding names this instance on another machine. Only the
          // authorities file can fix that, so the callout names the remedy
          // and offers nothing to press.
          await expect(inspector.getByTestId("resources-callout-next-step")).toContainText("authorityMachineId");
          await expect(inspector.getByTestId("resources-action-resolve")).toHaveCount(0);
          await expect(inspector.getByTestId("resources-action-request")).toHaveCount(0);
          await runAxe(window, "Resources inspector, ownership unresolved");
        });

        await test.step("inspector: changed definition offers to accept it", async () => {
          const inspector = await select(RESOURCES_AUDIT_CHANGED.displayName);
          await expect(inspector.getByRole("note")).toContainText("Ownership unresolved");
          await expect(inspector.getByTestId("resources-action-resolve")).toHaveText("Accept configured definition…");
          await expect(inspector.getByTestId("resources-action-request")).toHaveCount(0);
          await runAxe(window, "Resources inspector, changed definition");
        });

        await test.step("Resolve ownership dialog", async () => {
          const inspector = inspectorFor(RESOURCES_AUDIT_CHANGED.displayName);
          const dialog = window.getByRole("dialog", {
            name: `Resolve ownership of ${RESOURCES_AUDIT_CHANGED.displayName}?`, exact: true,
          });
          await checkDialogKeyboard(inspector.getByTestId("resources-action-resolve"), dialog);
          await expect(dialog).toContainText("Current checkouts and the queue are kept.");
          await runAxe(window, "Resolve ownership dialog");
          await dialog.getByRole("button", { name: "Accept configured definition", exact: true }).click();
          await expect(dialog).toBeHidden();
          await expect(chip(RESOURCES_AUDIT_CHANGED.resourceId, "available")).toBeVisible();
          await expect(inspector.getByTestId("resources-action-request")).toBeVisible();
        });

        await test.step("Request checkout dialog", async () => {
          const inspector = await select("This machine");
          const opener = inspector.getByTestId("resources-action-request");
          await expect(opener).toHaveText("Request checkout");
          const dialog = window.getByRole("dialog", { name: "Request checkout: This machine", exact: true });
          await checkDialogKeyboard(opener, dialog);
          await dialog.getByRole("textbox", { name: "Purpose", exact: true }).fill("Accessibility audit hold");
          await runAxe(window, "Request checkout dialog");
          await dialog.getByRole("button", { name: "Request checkout", exact: true }).click();
          await expect(inspector.getByText(/^Accessibility audit hold · /)).toBeVisible();
          await expect(chip(machineId, "busy")).toBeVisible();
        });

        await test.step("Release dialog", async () => {
          const inspector = inspectorFor("This machine");
          const dialog = window.getByRole("dialog", { name: "Release This machine?", exact: true });
          await checkDialogKeyboard(inspector.getByTestId("resources-action-release"), dialog);
          await runAxe(window, "Release checkout dialog");
          await dialog.getByRole("button", { name: "Release", exact: true }).click();
          await expect(chip(machineId, "available")).toBeVisible();
        });

        await test.step("Recovery dialog", async () => {
          await seedResourcesAuditRecovery(seed!);
          // The app reads the shared store on its next poll.
          await expect(chip(machineId, "recovery_required")).toBeVisible({ timeout: 10_000 });
          const inspector = inspectorFor("This machine");
          const recover = inspector.getByTestId("resources-action-recover");
          await expect(recover).toBeVisible();
          await runAxe(window, "Resources inspector, recovery required");
          const dialog = window.getByRole("dialog", { name: "Recover This machine", exact: true });
          await checkDialogKeyboard(recover, dialog);
          // Every recovery step renders: fence, verify cleanup, and the
          // administrative release with its audit note.
          await expect(dialog.getByRole("button", { name: "Fence old workload", exact: true })).toBeEnabled();
          await expect(dialog.getByRole("button", { name: "Verify cleanup and release", exact: true })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Administrative release", exact: true })).toBeVisible();
          await expect(dialog.getByLabel("Audit note", { exact: true })).toBeVisible();
          await runAxe(window, "Recovery dialog");
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await expect(dialog).toBeHidden();
        });

        await test.step("Register resource dialog", async () => {
          const opener = resources
            .getByRole("navigation", { name: "Resource navigation", exact: true })
            .getByRole("button", { name: "Register Resource", exact: true });
          const dialog = window.getByRole("dialog", { name: "Register resource", exact: true });
          await checkDialogKeyboard(opener, dialog);
          await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Bench signal generator");
          // A key the authority would refuse shows its problem and keeps
          // Save disabled, so the scan covers the problem text too.
          const key = dialog.getByRole("textbox", { name: "Canonical identity", exact: true });
          await key.fill("Signal Generator");
          await expect(key).toHaveAttribute("aria-invalid", "true");
          await expect(key).toHaveAccessibleDescription(/lowercase scheme/);
          const save = dialog.getByRole("button", { name: "Save draft", exact: true });
          await expect(save).toBeDisabled();
          // Counted adds the capacity field.
          await dialog.getByRole("radio", { name: "Counted", exact: true }).click();
          await expect(dialog.getByLabel("Capacity", { exact: true })).toBeVisible();
          await runAxe(window, "Register resource dialog");
          await key.fill("device:audit-bench/signal-generator");
          await expect(key).not.toHaveAttribute("aria-invalid");
          await save.click();
          await expect(dialog).toBeHidden();
        });

        await test.step("inspector: pending registration", async () => {
          const inspector = await select("Bench signal generator");
          await expect(inspector.getByRole("note")).toContainText("Pending registration");
          await runAxe(window, "Resources inspector, pending registration");
        });

        await profile.click();
        await mainWindow.getByTestId("profile-menu-resources").click();
        expect(app.electronApp.windows().filter((page) => page.url().endsWith("#resources"))).toEqual([window]);
        await expect(mainWindow.getByRole("region", { name: "Resources", exact: true })).toHaveCount(0);
      } finally {
        await app.close();
      }
    });

    test("research surfaces have no violations", async () => {
      const app = await launchAuditApp({
        ...appearance,
        fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
        preLaunchHook: async (homeRoot) => {
          enableResearchFixture(homeRoot);
          seedResearchState(stateDbPathForHomeRoot(homeRoot));
          seedLongResearchRun(stateDbPathForHomeRoot(homeRoot));
        },
      });
      try {
        // A live run owned by this app, so the run controls and review forms render.
        seedLiveResearchRun(stateDbPathForHomeRoot(app.homeRoot), readResearchOwnerIdentity(app.homeRoot, app.electronApp.process().pid!));
        await app.window.reload();
        await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
        await app.window.getByRole("tab", { name: "Research", exact: true }).click();
        const panel = app.window.getByRole("region", { name: "Research", exact: true });
        await expect(panel.getByLabel("Research map")).toBeVisible();
        await expect(panel.getByRole("button", { name: "Stop run…", exact: true })).toBeVisible();
        await runAxe(app.window, "research map");
        await panel.getByRole("tab", { name: "Findings", exact: true }).click();
        // The findings are read a page at a time after the tab opens; audit the cards, not the loading line.
        await expect(panel.getByLabel("Shared findings").getByRole("article").first()).toBeVisible();
        await runAxe(app.window, "research findings");
        await panel.getByRole("tab", { name: /^Review/ }).click();
        await expect(panel.getByText(/It is not formal verification/)).toBeVisible();
        await expect(panel.getByLabel("Reason for your decision").first()).toBeVisible();
        await runAxe(app.window, "research review");
        await panel.getByRole("button", { name: "Stop run…", exact: true }).click();
        await expect(panel.getByRole("group", { name: "Confirm stopping the run" })).toBeVisible();
        await runAxe(app.window, "research stop confirmation");
        await panel.getByRole("button", { name: "Keep running", exact: true }).click();
        await panel.getByRole("tab", { name: "Items", exact: true }).click();
        await expect(panel.getByLabel("Research items")).toBeVisible();
        await panel.getByRole("button", { name: /^Counterexample · In progress One failing trace/ }).click();
        await expect(panel.getByRole("heading", { name: "Counterexample from Invalidation order" })).toBeFocused();
        await runAxe(app.window, "research item detail");
        await panel.getByRole("tab", { name: "Activity", exact: true }).click();
        await expect(panel.getByLabel("Research activity").getByRole("listitem").first()).toBeVisible();
        await runAxe(app.window, "research activity");
        // A journal longer than one page adds the Show older control.
        await panel.getByRole("combobox", { name: "Run" }).click();
        await app.window.getByRole("option", { name: new RegExp(LONG_RESEARCH_OBJECTIVE.slice(0, 30)) }).click();
        await expect(panel.getByRole("button", { name: "Show older", exact: true })).toBeVisible();
        await runAxe(app.window, "research activity with older pages");
        await panel.getByRole("button", { name: "New run", exact: true }).click();
        await expect(panel.getByRole("textbox", { name: "Objective", exact: true })).toBeVisible();
        await runAxe(app.window, "research request form");
      } finally { await app.close(); }
    });

    // PR watches: the eye on a sidebar PR chip, the chip's hover card and
    // menu, and the rail's "Wakes this thread" list with its history. Nothing
    // else renders them: a watch exists only after an agent or Watch CI arms
    // one, and no replay fixture carries PRs at all.
    //
    // The list carries controls nothing else has: Stop, Turn Off and Watch CI
    // at 11px, a dashed hint box, a mono attempt aside in the menu, and a
    // history toggle that sits 4px into the card's padding. The hover card
    // adds a muted Auto-fix value.
    test("PR watch surfaces have no violations", async () => {
      // Five unscoped scans plus a launch, like the Directories block.
      test.setTimeout(75_000);
      const app = await launchAuditApp({
        ...appearance,
        fixturePath: PR_WATCHES_FIXTURE,
        env: NO_FORGE_CREDENTIALS,
        // Through the overlay store's own writers, so the PR list, the
        // Auto-fix opt-in and the watch table each keep one owner.
        preLaunchHook: async (homeRoot) => {
          await seedPrWatchAuditState(homeRoot);
        },
      });
      const watched = PR_WATCH_AUDIT_WATCHED_PR;
      const unwatched = PR_WATCH_AUDIT_UNWATCHED_PR;
      const repository = `${watched.org}/${watched.repo}`;
      try {
        const threadRow = app.window
          .getByRole("button", { name: /PR watch audit thread/i })
          .first();
        await expect(threadRow).toBeVisible();
        await threadRow.click();
        await expect(
          app.window.getByRole("heading", { level: 2, name: "PR watch audit thread" }),
        ).toBeVisible();

        // Scoped to the sidebar row: the rail's card draws the same chip with
        // the same name.
        const sidebarRow = app.window.locator("[data-thread-row-key]").filter({
          has: app.window.getByRole("button", { name: /PR watch audit thread/i }),
        });
        const sidebarChip = sidebarRow.getByRole("button", {
          name: new RegExp(`^Open ${repository}#${watched.number} .*, waiting for CI$`),
        });

        await test.step("sidebar PR chip with a CI watch", async () => {
          await expect(sidebarChip).toBeVisible();
          // The unwatched PR, behind the `+1 PR` chip, draws no eye. Without
          // both, a seed that armed nothing would leave this scan green on a
          // plain row.
          await expect(sidebarChip.locator(".pr-chip__watch")).toBeVisible();
          const overflowChip = sidebarRow.getByRole("button", {
            name: /^\+1 PR: 1 more pull request, [^,]*$/,
          });
          await expect(overflowChip).toBeVisible();
          await expect(overflowChip.locator(".pr-chip__watch")).toHaveCount(0);
          if (runsFunctionalChecks) {
            // The eye is drawn inside the 20px chip, not beside or below it.
            const chipBox = await sidebarChip.boundingBox();
            const eyeBox = await sidebarChip.locator(".pr-chip__watch").boundingBox();
            expect(chipBox).not.toBeNull();
            expect(eyeBox).not.toBeNull();
            expect(eyeBox!.x).toBeGreaterThanOrEqual(chipBox!.x);
            expect(eyeBox!.y).toBeGreaterThanOrEqual(chipBox!.y);
            expect(eyeBox!.x + eyeBox!.width).toBeLessThanOrEqual(chipBox!.x + chipBox!.width);
            expect(eyeBox!.y + eyeBox!.height).toBeLessThanOrEqual(chipBox!.y + chipBox!.height);
          }
          await runAxe(app.window, "sidebar PR chip with a CI watch");
        });

        await test.step("PR chip hover card with watches", async () => {
          await sidebarChip.hover();
          const card = app.window.locator(".pr-status-card").filter({
            hasText: "Wakes this thread",
          });
          await expect(card).toBeVisible();
          await expect(card).toContainText("attempt 2");
          await expect(card).toContainText("Merge or close");
          await expect(card).toContainText("Auto-fix");
          await runAxe(app.window, "PR chip hover card with watches");
          // Park the pointer so the card closes and no later scan sees it.
          await app.window.mouse.move(0, 0);
          await expect(card).toBeHidden();
        });

        await test.step("PR chip menu with watch items", async () => {
          await sidebarChip.click({ button: "right" });
          const menu = app.window.getByRole("menu");
          await expect(
            menu.getByRole("menuitem", { name: /^Stop Waiting for CI/ }),
          ).toBeVisible();
          await expect(
            menu.getByRole("menuitem", { name: "Stop Watching for Merge" }),
          ).toBeVisible();
          await runAxe(app.window, "PR chip menu with watch items");
          await app.window.keyboard.press("Escape");
          await expect(menu).toBeHidden();
        });

        const panel = app.window.locator("#context-rail-panel");
        const watchedCard = panel.locator(".rail-card").filter({
          hasText: watched.title!,
        });
        const unwatchedCard = panel.locator(".rail-card").filter({
          hasText: unwatched.title!,
        });

        await test.step("rail Pull requests panel with watches", async () => {
          await app.window.getByRole("tab", { name: /^Pull requests/ }).click();
          // One assertion per row kind, so a seed drifting to fewer watches
          // fails here instead of auditing a shorter list.
          await expect(watchedCard.getByText("Waiting for CI · attempt 2")).toBeVisible();
          await expect(watchedCard.getByText("Waiting for merge or close")).toBeVisible();
          await expect(
            watchedCard.getByRole("button", {
              name: `Stop waiting for CI on #${watched.number}`,
            }),
          ).toBeVisible();
          await expect(
            watchedCard.getByRole("button", {
              name: `Stop watching #${watched.number} for merge`,
            }),
          ).toBeVisible();
          await expect(
            watchedCard.getByRole("button", { name: "Turn off Auto-fix for this thread" }),
          ).toBeVisible();
          await expect(unwatchedCard.getByText("Not waiting for CI.")).toBeVisible();
          await expect(
            unwatchedCard.getByRole("button", { name: `Watch CI on #${unwatched.number}` }),
          ).toBeVisible();
          await app.window.mouse.move(0, 0);
          await runAxe(app.window, "rail Pull requests panel with watches");
        });

        await test.step("rail Pull requests watch history", async () => {
          const toggle = watchedCard.getByRole("button", { name: /^History/ });
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(watchedCard.getByText("Stopped by you")).toBeVisible();
          await expect(watchedCard.getByText("Stopped by the agent")).toBeVisible();
          await app.window.mouse.move(0, 0);
          await runAxe(app.window, "rail Pull requests watch history");
        });
      } finally {
        await app.close();
      }
    });

    // The Share storage dialog is reachable only from a worktree row, and
    // only when the selected Git's help lists `git worktree reflink`. No
    // fixture thread has a worktree that exists on disk, and what a real run
    // reports depends on the runner's filesystem, so this block links a real
    // directory to the smoke thread and selects a stand-in Git (see
    // fixtures/worktree-storage-seeding.ts). The main process still
    // authorizes the path against the thread and probes the Git's help
    // before the renderer is offered anything.
    test("share storage dialog has no violations", async () => {
      test.skip(
        process.platform === "win32",
        "The stand-in Git is a shell script, which Windows cannot run as PWRAGENT_GIT_PATH.",
      );
      // Three unscoped scans plus a launch, an estimate and a share. The same
      // budget as the neighbouring blocks, so a slow guest reports an axe
      // result and not a timeout from inside a step.
      test.setTimeout(75_000);
      const audit = await prepareWorktreeStorageAudit(test.info().outputPath("worktree-storage"));
      const app = await launchAuditApp({
        ...appearance,
        env: { PWRAGENT_GIT_PATH: audit.gitPath },
        preLaunchHook: async (homeRoot) => {
          await seedWorktreeStorageAuditState(homeRoot, audit);
        },
      });
      try {
        await app.window
          .getByRole("button", { name: /Replay smoke thread/i })
          .first()
          .click();
        await expect(
          app.window.getByRole("heading", { level: 2, name: "Replay smoke thread" }),
        ).toBeVisible();
        const contextRail = app.window.getByRole("complementary", { name: "Thread context" });
        await contextRail.getByRole("tab", { name: "Linked projects" }).click();
        await contextRail
          .getByRole("button", { name: `Share storage for ${WORKTREE_STORAGE_AUDIT_LABEL}`, exact: true })
          .click();
        const dialog = app.window.getByRole("dialog", { name: "Share worktree storage", exact: true });
        const verify = dialog.getByRole("checkbox", { name: /^Verify filtered files/ });
        const share = dialog.getByRole("button", { name: "Share storage", exact: true });

        await test.step("share storage estimate", async () => {
          // Without the estimate and the option, this would scan the
          // "Checking the selected Git..." state and pass on an empty dialog.
          await expect(dialog.getByText(/1,204 of 3,310 files can be shared, freeing about 412 MB\./))
            .toBeVisible();
          await expect(verify).toBeVisible();
          if (runsFunctionalChecks) {
            // Filter verification is never on until the operator asks.
            await expect(verify).not.toBeChecked();
            await expect(share).toBeEnabled();
          }
          await runAxe(app.window, "share storage estimate");
        });

        await test.step("share storage with filter verification chosen", async () => {
          await verify.check();
          await expect(verify).toBeChecked();
          await runAxe(app.window, "share storage with filter verification chosen");
        });

        await test.step("share storage result", async () => {
          await share.click();
          await expect(dialog.getByText(/Shared 1,204 files, freeing 412 MB\./)).toBeVisible();
          await expect(dialog.getByText(/Filtered files were verified\./)).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeVisible();
          await runAxe(app.window, "share storage result");
        });
      } finally {
        await app.close();
      }
    });

    // The Directories lens was never audited: every block above stays on the
    // fixture's default lens, so `.directory-row__threads` — which renders
    // `ThreadRow`'s `role="listitem"` children with no `role="list"` of its
    // own, unlike the `.sidebar-list--dense` the other lenses use — failed
    // `aria-required-parent` (critical) unnoticed. `KNOWN_VIOLATIONS` was
    // empty the whole time; the surface was unwaived, just unlooked-at.
    //
    // Its own fixture, in the same class as `star-map/`: the lens only shows
    // a directory row for a thread carrying `linkedDirectories`, and the list
    // under audit only mounts once that row is expanded. The smoke thread has
    // neither, so borrowing that fixture would scan an empty lens and stay
    // green over the bug this block exists to catch.
    test("directories lens has no violations", async () => {
      // Four unscoped scans plus a launch in one budget, against a window
      // rendering 15 sidebar rows. The neighbouring blocks do two, or scan
      // the much smaller map window. A slow guest otherwise reports "Test
      // timeout of 30000ms exceeded" from inside whichever step was running,
      // which costs exactly the attributability the per-step split buys.
      test.setTimeout(75_000);

      const app = await launchAuditApp({
        fixturePath: DIRECTORIES_FIXTURE,
        ...appearance,
        // Pins are desktop-local overlay state, not `thread/list` data, so no
        // fixture can produce them and the only UI path is a native context
        // menu. Without a pinned lane the directory renders undivided and the
        // "Directory threads" disclosure never mounts — the disclosure is what
        // needs a pin, not the pin-drop boundary, which mounts off
        // `onReorderThreadPins && directoryUnpinnedThreadCount > 0` and does
        // not read the pinned count at all. Two rather than one so the lane
        // has an order to get wrong.
        //
        // Through the app's own `setThreadPin` rather than a hand-written row:
        // the storage key format and the overlay payload shape then have one
        // owner instead of two that can drift apart silently.
        preLaunchHook: async (homeRoot) => {
          const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), {
            profileName: "default",
          });
          try {
            const overlay = new SqliteOverlayStore(stateDb);
            for (const [index, threadId] of DIRECTORIES_PINNED_THREAD_IDS.entries()) {
              await overlay.setThreadPin({
                backend: "codex",
                threadId,
                pinnedRank: String((index + 1) * 1024),
              });
            }
          } finally {
            stateDb.close();
          }
        },
      });
      try {
        // The initial exact selection owns automatic directory expansion.
        // Wait for that selection before changing the lens under its startup read.
        await expect(app.window.getByRole("heading", { level: 2, name: "Directories lens thread 01" })).toBeVisible();
        await app.window.getByRole("tab", { name: "directories" }).click();

        // Anchored, because Playwright matches an accessible name as a
        // substring by default and "Open new thread launchpad for PwrAgent"
        // is a sibling control on the same row. Anchored rather than `exact`
        // because the header's label is built by joining the directory name
        // with its state (`[label, "not configured on this instance",
        // activeCount, reviewCount].filter(Boolean).join(", ")`). `(,|$)`
        // rather than `\b`, which only stops a WORD character — `^PwrAgent\b`
        // also matches a sibling checkout called "PwrAgent-docs".
        const directory = app.window.getByRole("button", {
          name: /^PwrAgent(,|$)/,
        });
        await expect(directory).toBeVisible();

        // Scoped to this directory's row. `Threads in ${label}` is only as
        // unique as the label, which is a path basename — two checkouts of the
        // same repo give two lists the same name, and an unscoped locator then
        // fails Playwright strict mode rather than reporting anything about
        // accessibility.
        const directoryRow = app.window.locator(".directory-row").filter({ has: directory });
        const threads = directoryRow.getByRole("list", { name: /^Threads in PwrAgent/ });

        // Every scan below must measure the at-rest state, and a Playwright
        // click leaves the pointer where it landed.
        // `.directory-row__header:hover` lifts `.directory-row__launchpad-cluster`
        // from `opacity: 0` to `1`, and axe treats zero opacity as hidden — so
        // without this the collapsed scan would audit a hovered row while the
        // two before it audited an unhovered one, and the three would not be
        // comparable. It also keeps a latent failure from surfacing as a
        // mystery: the cluster's split-button chevron is 16x24, under the
        // `target-size` floor, and is absent here only because an isolated
        // E2E profile has no federation peers to offer.
        //
        // Scroll is the same kind of leftover. `.directory-row__header` is
        // `position: sticky; top: 0` with an opaque background, so once the
        // list is scrolled it covers whichever row is passing under it, and
        // axe measures a target's largest UNOBSCURED rect. The paging step
        // below calls `scrollIntoViewIfNeeded` to reach "Load more threads"
        // and leaves the list at an offset that bisected exactly one row —
        // `.thread-row__open` reported at 315x8.8px against the 24x24 floor,
        // on the narrower Windows window where that row happened to land
        // under the header. Nothing is design-wrong there: the row is whole
        // and clickable once scrolled to. So return the list to a defined
        // offset, the same way the pointer is returned to a defined corner.
        const settle = async () => {
          await app.window.mouse.move(0, 0);
          // Anchored on the directory row, not its thread list: the list is
          // unmounted for the collapsed scan, and a locator that resolves to
          // nothing does not no-op, it waits and then throws.
          await directoryRow.evaluate((row) => {
            for (
              let node = row.parentElement;
              node;
              node = node.parentElement
            ) {
              // Both halves matter. An element with `overflow: visible`
              // whose content is simply taller than its box also reports
              // `scrollHeight > clientHeight`, and assigning `scrollTop`
              // there does nothing — the walk would stop on it and leave the
              // real container scrolled.
              const overflowY = getComputedStyle(node).overflowY;
              if (
                (overflowY === "auto" || overflowY === "scroll")
                && node.scrollHeight > node.clientHeight + 1
              ) {
                node.scrollTop = 0;
                return;
              }
            }
          });
          // One frame, so sticky offsets settle before anything is measured.
          await app.window.evaluate(
            async () =>
              await new Promise((resolve) =>
                requestAnimationFrame(() => resolve(null)),
              ),
          );
        };

        // Establish an explicit user disclosure before paging and selection.
        await directory.click();
        await expect(directory).toHaveAttribute("aria-expanded", "false");
        await directory.click();
        await expect(directory).toHaveAttribute("aria-expanded", "true");

        await test.step("expanded directory thread list", async () => {
          // This row arrives open rather than being clicked open: the launch
          // selection falls back to `response.threads[0]`
          // (`getFallbackSelectionKey`) — NOT to the fixture's
          // `metadata.threadId`, which no selection path reads — and a
          // directory holding the selected thread renders expanded. So the
          // precondition is coupled to `thread-directories-01` carrying the
          // fixture's newest `updatedAt`; reorder that array and the
          // expansion moves to the PwrSnap row. Asserted, not assumed: the
          // list under audit only exists in this state.
          await expect(directory).toHaveAttribute("aria-expanded", "true");

          // Precondition assertions, not decoration. An expanded row that
          // rendered no threads would pass the axe scan below while auditing
          // nothing, and each control named here is one the fix had to keep
          // valid inside the list.
          await expect(threads).toBeVisible();
          // The seeded pins, asserted where they are used. With none, the
          // divider's `directoryPinnedThreads.length > 0` guard drops it and
          // the lane silently becomes 14 unpinned rows — the first failure
          // would be a 5s timeout on the control below, pointing nowhere near
          // the seeder.
          await expect(
            threads.locator('[data-thread-pin-state="pinned"]'),
          ).toHaveCount(2);
          await expect(
            threads.getByRole("button", {
              name: "Hide directory threads for PwrAgent",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            directoryRow.getByRole("button", { name: "Load more threads", exact: true }),
          ).toBeVisible();
          // Independent owner pages admit ten unpinned roots and two pins. The
          // Keep at top slot, the pin-drop boundary, and the section
          // disclosure are listitems; paging controls sit outside the list.
          //
          // Direct children: `getByRole` matches DESCENDANTS, so it would also
          // count a sub-thread list's own rows and read as fixture drift.
          await expect(listItems(threads)).toHaveCount(15);

          await settle();
          await runAxe(app.window, "directories lens, expanded directory");
        });

        await test.step("thread context menu", async () => {
          // A pinned row's menu has every item kind: the Pinned and Keep at
          // Top checkboxes, shortcut hints, the sub-thread cascade, and the
          // check-column indent. Its rows sit at exactly the 24px
          // target-size floor, so a padding change that shrinks them fails
          // here. The scan runs with the pointer still on the row, as a
          // right-click leaves it.
          await settle();
          await threads.locator('[data-thread-pin-state="pinned"]').first().click({ button: "right" });
          const menu = app.window.locator('.thread-context-menu[role="menu"]');
          await expect(menu).toBeVisible();
          await expect(
            menu.getByRole("menuitemcheckbox", { name: "Pinned", exact: true }),
          ).toHaveAttribute("aria-checked", "true");
          await runAxe(app.window, "directories lens, thread context menu");
          await app.window.keyboard.press("Escape");
          await expect(menu).toHaveCount(0);
        });

        await test.step("expanded unpinned overflow", async () => {
          const more = directoryRow.getByRole("button", { name: "Load more threads", exact: true });
          await more.scrollIntoViewIfNeeded();
          // The scroll anchor is #2001 paging behavior, not an audit input.
          const lastRow = threads.locator(".thread-row-shell").last();
          const anchor = runsFunctionalChecks
            ? {
                key: await lastRow.getAttribute("data-thread-pin-key"),
                box: await lastRow.boundingBox(),
              }
            : undefined;
          await more.click();
          await expect(listItems(threads)).toHaveCount(17);
          await expect(threads.locator('[data-thread-pin-state="pinned"]')).toHaveCount(2);
          if (anchor) {
            const { key, box: before } = anchor;
            if (!before || !key) throw new Error("Missing pagination scroll anchor");
            await expect.poll(async () => {
              const after = await threads.locator(`[data-thread-pin-key="${key}"]`).boundingBox();
              return after ? Math.abs(after.y - before.y) : Infinity;
            }).toBeLessThanOrEqual(2);
          }
          await expect(directoryRow.getByRole("button", { name: "Load more threads", exact: true })).toHaveCount(0);
          await settle();
          await runAxe(app.window, "directories lens, unpinned overflow");
        });

        // #2001 range-selection behavior. It runs no scan, so one appearance
        // covers it.
        if (runsFunctionalChecks) {
          await test.step("bulk context menu preserves the accumulated directory range", async () => {
            const unpinned = threads.locator('[data-thread-pin-state="unpinned"]');
            await unpinned.first().locator(".thread-row__open").click();
            await unpinned.last().locator(".thread-row__open").click({ modifiers: ["Shift"] });
            await unpinned.last().click({ button: "right" });
            const menu = app.window.getByRole("menu", { name: "Actions for 12 threads selected" });
            await expect(menu).toBeVisible();
            await menu.hover();
            await expect(unpinned).toHaveCount(12);
            await expect(threads.locator('[data-thread-pin-state="pinned"]')).toHaveCount(2);
            await expect(listItems(threads)).toHaveCount(17);
            await app.window.keyboard.press("Escape");
          });
        }

        await test.step("collapsed directory rows", async () => {
          // Collapsing unmounts the list, so this scan covers the directory
          // rows on their own — the state the lens opens in for every
          // directory that does not hold the selected thread.
          //
          // This holds only because selecting a directory does not touch
          // `selectedItemKey`: the force-expand effect in DirectoriesList
          // re-opens the row holding the selection whenever that key CHANGES,
          // and its explicit-collapse guard is what lets a click win. If
          // directory selection ever also selected the directory's launchpad,
          // the click would collapse and the effect would immediately
          // re-expand, and this assertion would never pass again.
          await directory.click();
          await expect(directory).toHaveAttribute("aria-expanded", "false");
          await expect(threads).toHaveCount(0);
          await settle();
          await runAxe(app.window, "directories lens, collapsed");
        });
        // #2001 retained-pages behavior; no scan, so one appearance.
        if (runsFunctionalChecks) {
          await test.step("user expansion restores loaded rows under a stationary pointer", async () => {
            await directory.click();
            await expect(directory).toHaveAttribute("aria-expanded", "true");
            // No mouse move or hover release while the retained pages refresh.
            // Reopening preserves the extra rows loaded above instead of resetting
            // the directory to its first ten unpinned roots.
            await expect(threads.locator('[data-thread-pin-state="pinned"]')).toHaveCount(2);
            await expect(threads.locator('[data-thread-pin-state="unpinned"]')).toHaveCount(12);
          });
        }
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
    // audit a different window entirely. It now renders inside a listitem
    // wrapper. This block is the gate on that, so keep the fixture active
    // and the scan unscoped.
    test("star map fixture surfaces have no violations", async () => {
      const app = await launchAuditApp({ ...appearance, fixturePath: STAR_MAP_FIXTURE });
      try {
        const attentionThread = app.window
          .getByRole("button", { name: /Star map attention thread/i })
          .first();

        await expect(attentionThread).toBeVisible();
        // The map lives in its own OS window; the header control spawns
        // it and every map assertion below runs against that window.
        const mapWindow = await openStarMapWindow(app);
        // The audit harness emulates reduced motion per Page, and the map
        // window is a different Page than the one `launchAuditApp`
        // configured — without this the card rise animation leaves text
        // mid-fade and axe reports phantom contrast misses.
        await mapWindow.emulateMedia({ reducedMotion: "reduce" });
        const starMap = mapWindow.getByRole("region", {
          name: "Star Map",
          exact: true,
        });
        const starMapCard = starMap.getByRole("button", {
          name: "Open thread: Star map attention thread",
          exact: true,
        });

        await test.step("star map window", async () => {
          await expect(starMap).toBeVisible();
          // Gate on a card rather than only the map body: cards populate
          // after the window mounts, and an empty map skips the card contrast.
          await expect(starMapCard).toBeVisible();
          // The menu trigger is transparent until hover or focus. Reveal it
          // before axe so coverage doesn't depend on where the native window
          // opens relative to the pointer.
          const secondCard = starMap.getByRole("button", {
            name: "Open thread: Second star map attention thread",
            exact: true,
          });
          const secondCardMenu = starMap.locator(".star-map-card__menu").filter({
            has: mapWindow.getByRole("button", {
              name: "Actions for Second star map attention thread",
              exact: true,
            }),
          });
          await secondCard.hover({ position: { x: 4, y: 4 } });
          await expect(secondCardMenu).toHaveCSS("opacity", "1");
          await runAxe(mapWindow, "star map window");
        });

        await test.step("star map intake dialog", async () => {
          await expect(starMap).toBeVisible();
          await expect(starMapCard).toBeVisible();
          // The [+] beside the local body carries the runner hostname, so
          // match the stable copy rather than a machine-specific label.
          await starMap.getByRole("button", { name: /^New thread on / }).click();
          const intake = mapWindow.getByRole("dialog", {
            name: /^New thread on /,
          });
          await expect(intake).toBeVisible();
          await expect(
            intake.getByRole("button", { name: "Start thread" }),
          ).toBeVisible();
          await runAxe(mapWindow, "star map intake dialog");

          await intake
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await expect(intake).toHaveCount(0);
        });

        await test.step("open thread view with an active thread", async () => {
          // Runs in the MAIN window; the map window staying open no
          // longer covers the thread view.
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

// Nothing else opens the composer popups, so the Tangerine pair scans them
// for every WCAG AA rule, contrast included, one launch per scheme, under the
// same describe titles the loop above gives Tangerine. The extra color themes
// skip this block: a color theme changes no role, name or attribute, and the
// popup paints only tokens, which theme-contract.test.tsx measures in every
// theme.
for (const theme of AUDIT_THEMES) {
  test.describe(`desktop renderer accessibility (WCAG2 AA, ${theme} theme)`, () => {
    // The default smoke fixture never opens a composer autocomplete, so its
    // listboxes and active-descendant targets otherwise remain outside the
    // gate. Audit both shapes: `$` is the shared listbox-of-options pattern,
    // while `@` also carries real Add buttons that must stay outside the
    // listbox rather than masquerading as directory options.
    test("composer autocomplete listbox semantics are valid", async () => {
      const app = await launchAuditApp({
        theme,
        fixturePath: COMPOSER_AUTOCOMPLETE_FIXTURE,
      });
      try {
        await app.window
          .getByRole("button", { name: /Skill autocomplete replay/i })
          .first()
          .click();
        const textbox = app.window.getByRole("textbox", { name: "Reply" });
        await expect(textbox).toBeVisible();

        await test.step("skills autocomplete", async () => {
          await textbox.fill("$ce");
          const skills = app.window.getByRole("listbox", { name: "Skills" });
          const activeOption = skills.getByRole("option").first();
          await expect(activeOption).toBeVisible();
          await expect(activeOption).toHaveAttribute("aria-selected", "true");
          await expect(textbox).toHaveAttribute(
            "aria-activedescendant",
            await activeOption.getAttribute("id") ?? "missing-option-id",
          );
          await runAxeScan(app.window, "skills autocomplete");
        });

        await test.step("directory autocomplete with sibling actions", async () => {
          await textbox.fill("@");
          const directories = app.window.getByRole("listbox", {
            name: "Projects and instances",
          });
          await expect(directories.getByRole("option").first()).toBeVisible();
          await expect(directories.getByRole("button")).toHaveCount(0);
          await expect(
            app.window.getByRole("button", { name: "+ Add directory…" }),
          ).toBeVisible();
          await expect(
            app.window.getByRole("button", { name: "+ Add file…" }),
          ).toBeVisible();
          await runAxeScan(
            app.window,
            "directory autocomplete with sibling actions",
          );
        });
      } finally {
        await app.close();
      }
    });
  });
}
