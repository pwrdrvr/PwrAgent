import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { openStarMapWindow } from "./fixtures/star-map-window";

test("discovers all project clouds and continues one project's cards in Electron", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-map-project-pages-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  const fixture = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/star-map/replay.fixture.json"), "utf8"));
  fixture.metadata.scenario = "star-map-project-pagination";
  fixture.steps.find((step: { method?: string }) => step.method === "thread/list").result =
    Array.from({ length: 15 }, (_, project) => Array.from({ length: 23 }, (_, card) => ({
      id: `project-${project}-card-${card}`, title: `Project ${project} card ${card}`, titleSource: "explicit",
      source: "codex", executionMode: "default", threadStatus: "active", updatedAt: 1760000100000 - card,
      linkedDirectories: [{ id: `dir-${project}`, kind: "local", label: `project-${project}`, path: `/repo/project-${project}` }],
    }))).flat();
  await writeFile(fixturePath, JSON.stringify(fixture));
  const app = await launchElectronApp({ fixturePath });
  try {
    const map = await openStarMapWindow(app);
    await expect(map.locator(".star-map__cluster-label")).toHaveCount(15);
    await expect(map.getByRole("button", { name: /^Load more project-\d+ threads$/ })).toHaveCount(15);
    const more = map.getByRole("button", { name: "Load more project-0 threads", exact: true });
    // Keyboard activation tests the real control even when this cloud is
    // outside the initial camera rectangle in a fifteen-project sky.
    await more.focus();
    await more.press("Enter");
    await expect(map.locator('[data-thread-key$="project-0-card-19"]')).toHaveCount(1);
    await expect(more).toBeEnabled();
    await more.press("Enter");
    await expect(map.locator('[data-thread-key$="project-0-card-22"]')).toHaveCount(1);
    await expect(more).toHaveCount(0);
    await expect(map.locator(".star-map__cluster-label")).toHaveCount(15);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
