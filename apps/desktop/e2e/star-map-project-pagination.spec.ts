import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { probeReport } from "./fixtures/probe-report";
import {
  focusStarMapWindow,
  openStarMapWindow,
} from "./fixtures/star-map-window";

/**
 * What the map looked like when a continuation did not arrive.
 *
 * `Load more` routes to `NavigationWindowController.loadMore`, whose `read`
 * returns immediately unless `isCurrent(resource)` — and that requires the
 * controller to be visible. `useStarMapProjectPages` sets visibility from
 * `useStarMapForeground`, which is
 * `visibilityState === "visible" && document.hasFocus()`. So a press landing
 * while this window is not foreground is dropped in silence: no error, no
 * spinner, no state change. It is also unrecoverable inside one attempt —
 * `setVisible(true)` re-reads each resource from the start rather than
 * replaying the continuation that was lost.
 *
 * Playwright emulates focus, which is why this normally holds. These two
 * readings say whether the emulation was in force at the moment the press
 * was dropped, which is the difference between that explanation and a
 * genuinely missing card.
 */
async function describeMissingContinuation(
  map: Page,
  threadKeySuffix: string,
): Promise<string> {
  const observed = await map.evaluate((suffix) => ({
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
    cards: document.querySelectorAll("[data-thread-key]").length,
    projectZeroCards: [...document.querySelectorAll("[data-thread-key]")]
      .map((card) => card.getAttribute("data-thread-key") ?? "")
      .filter((key) => key.includes("project-0-card-")).length,
    wanted: document.querySelectorAll(`[data-thread-key$="${suffix}"]`).length,
    loadMoreButtons: [...document.querySelectorAll("button")]
      .filter((button) => (button.textContent ?? "").includes("Load more"))
      .map((button) => ({
        label: (button.textContent ?? "").trim(),
        disabled: (button as HTMLButtonElement).disabled,
      })),
    activeElement: document.activeElement
      ? `${document.activeElement.tagName.toLowerCase()} ${JSON.stringify(
        (document.activeElement.textContent ?? "").trim().slice(0, 40),
      )}`
      : "<none>",
  }), threadKeySuffix);

  return [
    `  foreground: hasFocus=${observed.hasFocus}`
    + ` visibilityState=${observed.visibilityState}`,
    `  cards: total=${observed.cards} project-0=${observed.projectZeroCards}`
    + ` matching "${threadKeySuffix}"=${observed.wanted}`,
    `  load-more buttons: ${JSON.stringify(observed.loadMoreButtons)}`,
    `  focus is on: ${observed.activeElement}`,
  ].join("\n");
}

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
    // This spec paginates, and the map suspends every feed while it is not
    // foreground — a `Load more` press that lands then is dropped in
    // silence. That is intended behavior, so claim the foreground rather
    // than press and hope.
    await focusStarMapWindow(app, map);
    await expect(map.locator(".star-map__cluster-label")).toHaveCount(15);
    await expect(map.getByRole("button", { name: /^Load more project-\d+ threads$/ })).toHaveCount(15);
    const more = map.getByRole("button", { name: "Load more project-0 threads", exact: true });
    // Keyboard activation tests the real control even when this cloud is
    // outside the initial camera rectangle in a fifteen-project sky.
    // The control stays mounted while a project query refresh disables it.
    // Presence alone does not make it a keyboard target: focusing a disabled
    // button leaves focus on body and Enter cannot request a continuation.
    await expect(more).toBeEnabled();
    await more.focus();
    await expect(more).toBeFocused();
    await more.press("Enter");
    await expect(map.locator('[data-thread-key$="project-0-card-19"]')).toHaveCount(1)
      .catch(async (error: unknown) => {
        throw new Error(
          [
            "The continuation never rendered project-0-card-19.",
            await probeReport(async () =>
              await describeMissingContinuation(map, "project-0-card-19")),
          ].join("\n"),
          { cause: error },
        );
      });
    await expect(more).toBeEnabled();
    await more.press("Enter");
    await expect(map.locator('[data-thread-key$="project-0-card-22"]')).toHaveCount(1)
      .catch(async (error: unknown) => {
        throw new Error(
          [
            "The continuation never rendered project-0-card-22.",
            await probeReport(async () =>
              await describeMissingContinuation(map, "project-0-card-22")),
          ].join("\n"),
          { cause: error },
        );
      });
    await expect(more).toHaveCount(0);
    await expect(map.locator(".star-map__cluster-label")).toHaveCount(15);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
