import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedResearchPerformanceState } from "./fixtures/research-performance-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
test("1,000 contributions across ten workers stay navigable within the Research performance budget", async ({ playwright: _playwright }, testInfo) => {
  const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    preLaunchHook: async (homeRoot) => seedResearchPerformanceState(stateDbPathForHomeRoot(homeRoot)) });
  const measurements: Record<string, unknown> = { events: 1014, workerIdentities: 10, concurrentLimit: 8, interactionBudgetMs: 2_000, heapGrowthBudgetBytes: 64 * 1024 * 1024 };
  try {
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    const heap = () => app.window.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize);
    const beforeHeap = await heap();
    const start = performance.now();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    const panel = app.window.getByRole("region", { name: "Research", exact: true });
    await expect(panel.getByLabel("Recorded research graph")).toBeVisible();
    await expect(panel.locator(".research-graph__branch")).toHaveCount(10);
    const openMs = performance.now() - start;
    measurements.openMs = openMs;
    expect(openMs).toBeLessThan(2_000);
    await expect(panel.locator(".research-node--finding")).toHaveCount(60);
    const itemsStart = performance.now();
    await panel.getByRole("button", { name: "Items", exact: true }).click();
    await panel.getByRole("searchbox", { name: "Search items", exact: true }).fill("contribution 999");
    await panel.getByRole("button", { name: "Search", exact: true }).click();
    await panel.getByRole("button", { name: /Invented contribution 999/ }).click();
    await expect(panel.getByLabel("Selected research item")).toContainText("finding-999");
    const searchAndReadMs = performance.now() - itemsStart;
    measurements.searchAndReadMs = searchAndReadMs;
    expect(searchAndReadMs).toBeLessThan(2_000);
    const afterHeap = await heap();
    measurements.beforeHeap = beforeHeap; measurements.afterHeap = afterHeap;
    expect(beforeHeap).toBeDefined(); expect(afterHeap).toBeDefined();
    const growth = afterHeap! - beforeHeap!;
    measurements.heapGrowthBytes = growth;
    expect(growth).toBeLessThan(64 * 1024 * 1024);
  } finally {
    await testInfo.attach("research-performance.json", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
    await app.close();
  }
});
