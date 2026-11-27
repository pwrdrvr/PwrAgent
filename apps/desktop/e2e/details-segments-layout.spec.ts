import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedThreadSubAgents } from "./fixtures/sub-agent-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Every rail width the resize handle can reach, narrowest last. The Details
// segments used four equal columns, so "Jobs 12" ran under its neighbour and
// out of its own button below about 420px.
test("fits each Details segment inside its button at every rail width", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: { width: 1280, height: 820 },
  });
  try {
    // A two-digit Jobs count: the widest segment the fixture can draw.
    seedThreadSubAgents({
      stateDbPath: stateDbPathForHomeRoot(app.homeRoot),
      subAgents: Array.from({ length: 12 }, (_, index) => ({
        monitorId: `running-${index}`,
        task: `Running fixture task ${index}`,
        status: "running" as const,
        createdAt: 1_800_000_000_000 + index,
        updatedAt: 1_800_000_000_000 + index,
      })),
      threadId: "thread-smoke",
    });
    await app.window.reload();
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();

    const showRail = app.window.getByRole("button", { name: /^Show context rail/ });
    if (await showRail.isVisible()) await showRail.click();
    const rail = app.window.getByRole("complementary", { name: "Thread context" });
    await rail.getByRole("tab", { name: /^Details/ }).click();
    const segments = rail.getByRole("tablist", { name: "Details" });
    await expect(segments.getByRole("tab", { name: /^Jobs/ })).toContainText("12");

    // Widest first, then one keyboard step (16px) at a time to the minimum.
    const handle = app.window.getByRole("separator", { name: "Resize context rail" });
    await handle.focus();
    for (let step = 0; step < 20; step += 1) await app.window.keyboard.press("ArrowLeft");
    const widths: number[] = [];
    for (;;) {
      const width = Number(await handle.getAttribute("aria-valuenow"));
      widths.push(width);
      const misfits = await segments.evaluate((strip) => {
        const out: string[] = [];
        const stripBox = strip.getBoundingClientRect();
        const panel = strip.closest(".details-panel")?.getBoundingClientRect();
        if (panel && stripBox.right > panel.right + 0.5) out.push(`strip ends at ${stripBox.right}, panel at ${panel.right}`);
        for (const tab of strip.querySelectorAll<HTMLElement>('[role="tab"]')) {
          const box = tab.getBoundingClientRect();
          if (tab.scrollWidth > tab.clientWidth) out.push(`${tab.textContent} overflows its button`);
          // Only what draws: a label hidden for the icon layout is clipped away.
          for (const part of tab.children) {
            const style = getComputedStyle(part);
            if (style.display === "none" || style.clipPath !== "none") continue;
            const partBox = part.getBoundingClientRect();
            if (partBox.left < box.left + 6 - 0.5 || partBox.right > box.right - 6 + 0.5) {
              out.push(`${tab.textContent}: "${part.textContent}" reaches the button edge`);
            }
          }
        }
        return out;
      });
      expect(misfits, `rail width ${width}`).toEqual([]);
      if (width <= 300) break;
      await app.window.keyboard.press("ArrowRight");
      await expect(handle).not.toHaveAttribute("aria-valuenow", String(width));
    }
    expect(widths[0]).toBe(560);
    expect(widths.at(-1)).toBe(300);
  } finally {
    await app.close();
  }
});
