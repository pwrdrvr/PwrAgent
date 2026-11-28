import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import fc from "fast-check";

const minHeight = 140;
const maxHeight = 560;
const arrowStep = 16;
const readyText = "fixture-ready";

type Resize =
  | { kind: "drag"; delta: number }
  | { kind: "arrow"; key: "ArrowUp" | "ArrowDown" };

type Action =
  | Resize
  | { kind: "height" | "window"; height: number }
  | { kind: "add" | "exit" | "error" | "hover" }
  | { kind: "select"; ordinal: number }
  | { kind: "output"; lines: number };

const heights = fc.integer({ min: minHeight, max: maxHeight });
const windowHeights = fc.integer({ min: 420, max: 1100 });
const actions: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant("height"), height: heights }),
  fc.record({ kind: fc.constant("window"), height: windowHeights }),
  fc.record({ kind: fc.constant("drag"), delta: fc.integer({ min: -300, max: 300 }).filter((delta) => delta !== 0) }),
  fc.record({ kind: fc.constant("arrow"), key: fc.constantFrom("ArrowUp", "ArrowDown") }),
  fc.constant({ kind: "add" }),
  fc.constant({ kind: "exit" }),
  fc.constant({ kind: "error" }),
  fc.constant({ kind: "hover" }),
  fc.record({ kind: fc.constant("select"), ordinal: fc.nat(5) }),
  fc.record({ kind: fc.constant("output"), lines: fc.integer({ min: 1, max: 60 }) }),
);

type Scenario = {
  height: number;
  windowHeight: number;
  steps: Action[];
};

const regressions: { name: string; scenario: Scenario }[] = [
  {
    name: "the resize grip leaves no layout band and owns its press target",
    scenario: {
      height: 200, windowHeight: 800,
      steps: [{ kind: "drag", delta: -33 }, { kind: "add" }, { kind: "select", ordinal: 0 }],
    },
  },
  {
    name: "the New terminal hit test tolerates a rail scrolled to the fourth tab",
    scenario: {
      height: 141, windowHeight: 426,
      steps: [{ kind: "add" }, { kind: "add" }, { kind: "add" }, { kind: "select", ordinal: 3 }],
    },
  },
  {
    name: "xterm leaves fit remainder below the last row and paints the IPC error",
    scenario: { height: 230, windowHeight: 800, steps: [{ kind: "height", height: 215 }, { kind: "error" }] },
  },
  {
    name: "a remembered 560px panel keeps its rows and ended bar inside a 640px window",
    scenario: {
      height: 560, windowHeight: 900,
      steps: [{ kind: "output", lines: 60 }, { kind: "exit" }, { kind: "window", height: 640 }],
    },
  },
  {
    name: "dragging down and ArrowDown both shrink from the painted height",
    scenario: {
      height: 560, windowHeight: 640,
      steps: [
        { kind: "drag", delta: 60 },
        { kind: "height", height: 560 },
        { kind: "arrow", key: "ArrowDown" },
        { kind: "arrow", key: "ArrowUp" },
      ],
    },
  },
];

async function openFixture(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/terminal.html");
  await page.waitForFunction(() => Boolean(window.terminalLayout));
  return pageErrors;
}

async function setWindowHeight(page: Page, height: number) {
  await page.setViewportSize({ width: 1000, height });
}

async function replay(page: Page, scenario: Scenario) {
  await setWindowHeight(page, scenario.windowHeight);
  await page.mouse.move(0, 0);
  await page.evaluate((height) => window.terminalLayout.reset(height), scenario.height);

  const activePane = page.getByRole("tabpanel");
  const activeTab = page.getByRole("tab", { selected: true });
  const tabs = page.getByRole("tab");
  const grip = page.getByRole("separator", { name: "Resize terminal" });
  const newTerminal = page.getByRole("button", { name: "New terminal", exact: true });
  const hoverRail = async () => {
    await newTerminal.hover();
    await page.locator(".thread-terminal-panel__rail.is-open").waitFor();
  };
  const waitForOutput = (text: string) => activePane.locator(".xterm-rows").getByText(text, { exact: true }).waitFor();
  const ended = new Set<string>();
  const failed = new Set<string>();

  const check = async () => {
    const layout = await page.evaluate(() => window.terminalLayout.measure());
    const id = layout.sessionId;
    expect(layout.errorRow, "O1 the IPC error row is fully painted when present").toBe(failed.has(id) ? "painted" : "absent");
    expect(layout.topGap, "O1 first row starts after only padding and any error row").toBeGreaterThanOrEqual(0);
    expect(layout.topGap, "O1 first row starts after only padding and any error row").toBeLessThanOrEqual(10);
    expect(
      { rows: layout.paintedRows, endedBar: layout.endedBar },
      "O2 all rows and the ended-shell bar are fully painted",
    ).toEqual({ rows: layout.gridRows, endedBar: ended.has(id) ? "painted" : "absent" });
    expect(layout.bottomGap, "O3 viewport has less than one unused row below the grid").toBeLessThan(layout.rowHeight);
    expect(layout.gripClearance, "O4 the grip ends above the first row").toBeGreaterThanOrEqual(0);
    expect(layout.gripHit, "O4 a press on the grip hits the grip").toBe(true);
    expect(layout.newTerminalHit, "O4 the New terminal button keeps its own hit target").toBe(true);
    expect(layout.ptyRows, "O5 the last PTY size equals the painted row count").toBe(layout.paintedRows);
    return layout;
  };

  await waitForOutput(readyText);
  let layout = await check();
  for (const [index, step] of scenario.steps.entries()) {
    layout = await test.step(`step ${index + 1}: ${JSON.stringify(step)}`, async () => {
      const current = layout.sessionId;
      switch (step.kind) {
        case "height":
          await page.evaluate((height) => window.terminalLayout.setHeight(height), step.height);
          break;
        case "window":
          await setWindowHeight(page, step.height);
          break;
        case "drag": {
          const { x, y } = layout.gripPoint;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x, y + step.delta);
          await page.mouse.up();
          break;
        }
        case "arrow":
          await grip.press(step.key);
          break;
        case "add":
          await newTerminal.click();
          await expect(activeTab).not.toHaveAttribute("aria-controls", `terminal-panel-${current}`);
          await waitForOutput(readyText);
          break;
        case "select": {
          await hoverRail();
          const tab = tabs.nth(step.ordinal % await tabs.count());
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          break;
        }
        case "exit":
          if (ended.has(current)) break;
          await page.evaluate((id) => window.terminalLayout.end(id), current);
          ended.add(current);
          break;
        case "error":
          await page.evaluate((id) => window.terminalLayout.fail(id), current);
          failed.add(current);
          break;
        case "output": {
          if (ended.has(current)) break;
          const marker = `output-${index}`;
          const data = "\r\n" + "terminal output\r\n".repeat(step.lines) + marker;
          await page.evaluate(({ id, data }) => window.terminalLayout.write(id, data), { id: current, data });
          await waitForOutput(marker);
          break;
        }
        case "hover":
          await hoverRail();
          break;
      }
      const next = await check();
      if (step.kind === "drag" || step.kind === "arrow") {
        const delta = step.kind === "drag" ? -step.delta : step.key === "ArrowDown" ? -arrowStep : arrowStep;
        const requested = Math.max(minHeight, Math.min(maxHeight, Math.round(layout.paintedHeight) + delta));
        const painted = Math.min(requested, next.availableHeight);
        const oracle = delta < 0 ? "O6 shrink from the painted height" : "O4 resize from the painted height";
        expect.soft(next.paintedHeight, oracle).toBeCloseTo(painted, 1);
        expect.soft(next.rememberedHeight, "O4 remember the clamped resize request").toBe(requested);
      }
      return next;
    });
  }
}

for (const { name, scenario } of regressions) {
  test(name, async ({ page }) => {
    const errors = await openFixture(page);
    await replay(page, scenario);
    expect(errors).toEqual([]);
  });
}

test.describe("terminal layout search", () => {
  const replaySeed = process.env.PWRAGENT_LAYOUT_SEED;
  test.skip(
    process.env.PWRAGENT_TERMINAL_LAYOUT_SEARCH !== "1" && replaySeed === undefined,
    "Set PWRAGENT_TERMINAL_LAYOUT_SEARCH=1 to run the generated terminal model",
  );

  test("generated terminal transitions preserve the painted layout", async ({ page }) => {
    const seed = Number(replaySeed ?? randomInt(-(2 ** 31), 2 ** 31));
    if (!Number.isInteger(seed) || (seed | 0) !== seed) {
      throw new Error("PWRAGENT_LAYOUT_SEED must be a signed 32-bit integer");
    }
    const errors = await openFixture(page);
    const scenarios = fc.sample(fc.record({
      height: heights,
      windowHeight: windowHeights,
      steps: fc.array(actions, { minLength: 3, maxLength: 5 }),
    }), { seed, numRuns: 5 });

    for (const [index, scenario] of scenarios.entries()) {
      await test.step(`terminal seed ${seed}, case ${index + 1}, start ${scenario.height}px in ${scenario.windowHeight}px`, async () => {
        await replay(page, scenario);
        expect(errors).toEqual([]);
      });
    }
  });
});
