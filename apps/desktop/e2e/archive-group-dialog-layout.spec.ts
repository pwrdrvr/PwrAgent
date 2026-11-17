import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  archiveGroupDialogLayoutViolations,
  resetArchiveGroupDialogScroll,
} from "./fixtures/archive-group-dialog-layout-oracle";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";

/**
 * The archive group confirmation in real layout, across group sizes, window
 * sizes and zoom. Its first version hid that the list scrolled, and at
 * 300% zoom its buttons left the window; a first fix squeezed the list to
 * an empty frame. The rules are in `archive-group-dialog-layout-oracle.ts`.
 * In headless Chromium, the stylesheets of 40d0095 and d80b896 fail them
 * (an unframed overflowing list, and a list collapsed to 31px).
 */
const LONG_TITLE = "Reconcile the federation inventory after the owner rotated its signing key and every peer re-announced";
const GROUPS = [
  { root: "Pair review", size: 2 },
  { root: "Six-step migration", size: 6 },
  { root: "Forty-file refactor", size: 40 },
  { root: "Hundred-twenty sweep", size: 120 },
];
const LAUNCH_SIZE = { width: 1440, height: 900 };

test("keeps the archive group confirmation usable at every window size and zoom", async ({ browserName: _browserName }) => {
  test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-group-layout-"));
  const projectPath = path.join(root, "Harbor");
  await mkdir(projectPath);
  // A summary always carries its linked directories; main iterates them.
  const linkedDirectories = [{ id: projectPath, path: projectPath, label: "Harbor", kind: "local" as const }];
  const threads = GROUPS.flatMap((group, groupIndex) => [
    { id: `root-${groupIndex}`, parent: undefined as string | undefined, title: group.root },
    ...Array.from({ length: group.size - 1 }, (_, index) => ({
      id: `child-${groupIndex}-${index}`,
      parent: `root-${groupIndex}`,
      // Every fifth row is long enough to have to truncate.
      title: index % 5 === 0 ? `Step ${index + 1}: ${LONG_TITLE}` : `Step ${index + 1} of ${group.root}`,
    })),
  ]).map((thread, index) => ({ ...thread, linkedDirectories, titleSource: "explicit", source: "codex",
    executionMode: "default", updatedAt: 10_000 - index }));
  const fixturePath = path.join(root, "archive-group-layout.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "archive-group-dialog-layout", threadId: "root-0" },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        // Archive must be advertised for the menu to offer it. The spec
        // dismisses every confirmation, so no archive request is answered.
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "thread/archive"],
      } },
      { id: "list", kind: "response", method: "thread/list", result: threads.map(({ parent: _parent, ...thread }) => thread) },
      ...threads.map((thread) => ({ id: `read-${thread.id}`, kind: "response", method: "thread/read", threadId: thread.id,
        result: { entries: [{ type: "message", id: `message-${thread.id}`, role: "assistant", text: "Layout fixture." }],
          messages: [{ id: `message-${thread.id}`, role: "assistant", text: "Layout fixture." }],
          pagination: { supportsPagination: false, hasPreviousPage: false } },
      })),
    ],
  }, null, 2));

  const app = await launchElectronApp({ fixturePath, windowSize: LAUNCH_SIZE,
    preLaunchHook: async (homeRoot) => {
      const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
      try {
        const overlay = new SqliteOverlayStore(stateDb);
        for (const thread of threads) {
          if (!thread.parent) continue;
          await overlay.setThreadParent({ backend: "codex", threadId: thread.id,
            parentThreadId: thread.parent, parentThreadBackend: "codex" });
        }
      } finally {
        stateDb.close();
      }
    },
  });
  const sizeWindow = async (size: { width: number; height: number; zoom: number }) => {
    await app.electronApp.evaluate(({ BrowserWindow }, next) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Expected the PwrAgent window.");
      window.setMinimumSize(0, 0);
      window.setContentSize(next.width, next.height);
      window.webContents.setZoomFactor(next.zoom / 100);
    }, size);
    return settledViewport(app.window, { width: size.width * 100 / size.zoom, height: size.height * 100 / size.zoom });
  };
  try {
    const dialog = app.window.getByRole("dialog", { name: /^Archive \d+ Threads\?$/ });
    for (const group of GROUPS) {
      await sizeWindow({ ...LAUNCH_SIZE, zoom: 100 });
      await app.window.getByRole("button", { name: new RegExp(`^${group.root}`) }).click({ button: "right" });
      await app.window.getByRole("menuitem", { name: /^Archive Thread and Sub-Threads\./ }).click();
      await expect(dialog).toHaveAccessibleName(`Archive ${group.size} Threads?`);
      await expect(dialog.getByRole("listitem")).toHaveCount(group.size);

      // The minimum window at 100% and at 300%, then a sweep from the
      // minimum window to a laptop screen and from 100% to 320% zoom.
      await fc.assert(fc.asyncProperty(fc.record({
        width: fc.integer({ min: 960, max: 1440 }),
        height: fc.integer({ min: 640, max: 900 }),
        zoom: fc.integer({ min: 100, max: 320 }),
      }), async (size) => {
        const viewport = await sizeWindow(size);
        await resetArchiveGroupDialogScroll(app.window);
        const violations = await archiveGroupDialogLayoutViolations(app.window);
        expect(violations, `${group.size} threads in a ${viewport.width}x${viewport.height} CSS viewport`).toEqual([]);
      }), { numRuns: 12, examples: [
        [{ width: 960, height: 640, zoom: 100 }],
        [{ width: 960, height: 640, zoom: 300 }],
      ] });

      // Escape still belongs to the dialog after the sweep, and archives nothing.
      await app.window.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await sizeWindow({ ...LAUNCH_SIZE, zoom: 100 });
      await expect(app.window.getByRole("button", { name: new RegExp(`^${group.root}`) })).toBeVisible();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Waits for the resize and zoom to reach the renderer: the CSS viewport is
 * within a pixel of the expected size, rounded either way. A window manager
 * may adjust a requested size, and the rules measure the real viewport, so
 * after 50 frames a viewport that holds still is accepted as it is.
 */
async function settledViewport(
  window: Page,
  expected: { width: number; height: number },
): Promise<{ width: number; height: number }> {
  const read = () => window.evaluate(() => new Promise<{ width: number; height: number }>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight })));
  }));
  let observed = await read();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (Math.abs(observed.width - expected.width) <= 1.5 && Math.abs(observed.height - expected.height) <= 1.5) {
      return observed;
    }
    observed = await read();
  }
  const steady = await read();
  if (steady.width === observed.width && steady.height === observed.height) return steady;
  throw new Error(`The viewport kept changing, last ${steady.width}x${steady.height}; expected about ${Math.round(expected.width)}x${Math.round(expected.height)}.`);
}
