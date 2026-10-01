import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  specDir,
  "fixtures/a11y-directories/replay.fixture.json",
);

const PINNED_THREAD_IDS = [
  "thread-directories-01",
  "thread-directories-02",
  "thread-directories-03",
];

/**
 * A dropped pin reorder must show under the pointer that dropped it.
 *
 * The sidebar freezes its rows while the pointer rests on them, so background
 * churn cannot move a target between pointer-down and click. A drop is the
 * operator's own command and releases that freeze, but the drop itself
 * changes the DOM under the stationary pointer, and the browser answers with
 * a `pointerover`. That used to re-freeze the order from before the reorder,
 * which then held until the pointer left the rows: the drop looked ignored.
 * jsdom dispatches no boundary events of its own, so only a real browser
 * shows whether the freeze comes back.
 */
test("a dropped pin reorder repaints without the pointer leaving the rows", async () => {
  const app = await launchElectronApp({
    fixturePath,
    // Pins are desktop-local overlay state that no fixture can produce.
    // Seeded through the app's own store, as `a11y.spec.ts` does.
    preLaunchHook: async (homeRoot) => {
      const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), {
        profileName: "default",
      });
      try {
        const overlay = new SqliteOverlayStore(stateDb);
        for (const [index, threadId] of PINNED_THREAD_IDS.entries()) {
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
    await expect(app.window.getByRole("heading", {
      level: 2,
      name: "Directories lens thread 01",
    })).toBeVisible();
    await app.window.getByRole("tab", { name: "directories" }).click();

    const directory = app.window.getByRole("button", { name: /^PwrAgent(,|$)/ });
    const directoryRow = app.window.locator(".directory-row").filter({ has: directory });
    const pinnedRows = directoryRow.locator(
      '.thread-row-shell[data-thread-pin-state="pinned"]',
    );
    const pinnedTitles = () =>
      pinnedRows.locator(".thread-row__title").allTextContents();
    await expect.poll(pinnedTitles).toEqual([
      "Directories lens thread 01",
      "Directories lens thread 02",
      "Directories lens thread 03",
    ]);

    const third = await pinnedRows.nth(2).boundingBox();
    if (!third) {
      throw new Error("Expected the pinned rows to have layout");
    }
    await app.window.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
    await app.window.mouse.down();
    await app.window.mouse.move(third.x + third.width / 2, third.y, { steps: 4 });
    // The active drag opens a Keep at top slot above the pins, which moves
    // the first pin down. Measure it after that, so the drop is an ordinary
    // reorder before it rather than a Keep at top drop.
    await expect(directoryRow.locator(".directory-row__keep-top-slot--ghost")).toBeVisible();
    const first = await pinnedRows.nth(0).boundingBox();
    if (!first) {
      throw new Error("Expected the pinned rows to have layout");
    }
    const to = { x: first.x + first.width / 2, y: first.y + first.height / 4 };
    await app.window.mouse.move(to.x, to.y, { steps: 8 });
    await expect(pinnedRows.nth(0)).toHaveClass(/is-drop-target-before/);
    await app.window.mouse.up();

    // The pointer stays where it dropped. The poll budget is far below the
    // four seconds the frozen order used to survive.
    await expect.poll(pinnedTitles, { timeout: 2_000 }).toEqual([
      "Directories lens thread 03",
      "Directories lens thread 01",
      "Directories lens thread 02",
    ]);
    expect(await app.window.evaluate(([x, y]) =>
      Boolean(document.elementFromPoint(x, y)?.closest(".directory-row")),
    [to.x, to.y])).toBe(true);
  } finally {
    await app.close();
  }
});
