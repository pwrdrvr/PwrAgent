import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { expect, test, type Locator } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const fixturePath = path.join(import.meta.dirname, "fixtures/long-thread-scroll-stability/replay.fixture.json");
const threadId = "33333333-3333-4333-8333-333333333333";
const title = "Claude image scroll stability";

function screenshotSource(width: number, height: number, index: number): string {
  const fills = ["teal", "steelblue", "indigo", "darkolivegreen"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" rx="8" fill="${fills[index % fills.length]}"/>
    <path d="M24 22h112M24 37h72M24 52h80" stroke="white" stroke-width="4"/>
    <text x="125" y="63" fill="white" font-family="sans-serif">${index + 1}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function scrollUpTo(locator: Locator, offset: number) {
  return locator.evaluate((element, targetOffset) => {
    const scroller = element.closest<HTMLElement>(".transcript-list__items")!;
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    scroller.scrollTop += element.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top - targetOffset;
    scroller.dispatchEvent(new Event("scroll"));
    return element.getBoundingClientRect().top;
  }, offset);
}

test("keeps a screenshot in place when a higher line of a folded Claude image gallery grows", async () => {
  const turn = { id: "capture-turn", status: "completed" as const, startedAt: 100, completedAt: 10_000 };
  const entries: AppServerThreadEntry[] = [
    { type: "message", id: "start", role: "user", text: "Capture the dashboard layouts.", turn },
    ...Array.from({ length: 12 }, (_, index): AppServerThreadEntry => ({
      type: "activity",
      id: `capture-${index}`,
      status: "completed",
      summary: `Captured dashboard ${index}`,
      turn,
      details: [{
        kind: "read",
        id: `result-${index}`,
        label: "Screenshot",
        images: [{
          type: "image",
          url: index === 0 ? screenshotSource(1, 1, index) : screenshotSource(165, 72, index),
          alt: `Dashboard ${index}`,
        }],
      }],
    })),
    { type: "message", id: "answer", role: "assistant", phase: "final", text: "The dashboards are ready.", turn },
    ...Array.from({ length: 4 }, (_, index): AppServerThreadEntry => ({
      type: "message",
      id: `follow-up-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: [
        `Dashboard follow-up ${index + 1}`,
        "Check the heading against the design.",
        "Confirm the filters fit above the table.",
        "Compare the small-screen layout.",
      ].join("\n\n"),
    })),
  ];

  const app = await launchElectronApp({
    fixturePath,
    windowSize: { width: 1000, height: 640 },
    preLaunchHook: async (homeRoot) => {
      const root = path.join(homeRoot, ".pwragent/profiles/default/state/claude");
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, `${threadId}.json`), JSON.stringify({
        cwd: homeRoot,
        thread: { id: threadId, title, titleSource: "explicit", source: "claude",
          updatedAt: Date.now(), linkedDirectories: [] },
      }));
      await writeFile(path.join(root, `${threadId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    },
  });
  try {
    const { window } = app;
    await window.getByRole("button", { name: new RegExp(title) }).first().click();
    const list = window.locator(".transcript-list__items");
    await expect(list.getByText("Dashboard follow-up 4")).toBeVisible();
    await expect.poll(() => list.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);

    // The first Claude page is the tail. Scrolling up loads the earlier work.
    await list.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    const gallery = list.getByRole("group", { name: "Images from previous work" });
    const earlier = gallery.getByAltText("Dashboard 0", { exact: true });
    const current = gallery.getByAltText("Dashboard 8", { exact: true });
    const images = gallery.locator("img");
    await expect(images).toHaveCount(12);
    // Visit each tile so its lazy preview has settled at any scrollport size.
    for (const image of await images.all()) {
      await scrollUpTo(image, 40);
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
    }
    const before = await scrollUpTo(current, 22);
    // Change intrinsic size only after the reader is parked on a lower tile.
    // Using embedded images makes the decode order independent of the network.
    await earlier.evaluate(async (image: HTMLImageElement, source) => {
      image.src = source;
      await image.decode();
    }, screenshotSource(165, 310, 0));
    await window.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const after = await current.evaluate((element) => element.getBoundingClientRect().top);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});
