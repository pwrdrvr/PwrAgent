import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedThreadSubAgents } from "./fixtures/sub-agent-state-seeding";

const smokeSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("opens a thread and enables replies with oversized historical sub-agent detail", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(smokeSpecDir, "fixtures/smoke/replay.fixture.json"),
  });
  try {
    const subAgents = Array.from({ length: 738 }, (_, index) => ({
      monitorId: `history-${index}`,
      task: `Historical task ${index}: ${"bounded history record ".repeat(80)}`,
      status: "success" as const,
      createdAt: 1_800_000_000_000 + index,
      updatedAt: 1_800_000_000_000 + index,
    }));
    expect(Buffer.byteLength(JSON.stringify(subAgents))).toBeGreaterThan(1024 * 1024);
    seedThreadSubAgents({
      stateDbPath: stateDbPathForHomeRoot(app.homeRoot),
      subAgents,
      threadId: "thread-smoke",
    });
    await app.window.reload();
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await app.window.getByLabel("Reply").fill("A reply remains available with a large history.");
    await expect(app.window.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(app.window.getByText(/Selected thread detail exceeds the result budget/)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("loads the hydrated desktop shell with its main-process window title", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      smokeSpecDir,
      "fixtures/smoke/replay.fixture.json"
    )
  });

  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Replay smoke thread"
      })
    ).toBeVisible();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await expect(
      app.window.getByRole("tab", {
        name: "Thread info"
      })
    ).toBeVisible();

    // The hydrated thread above gates on a mounted renderer. The clobber this
    // guards against happened when the page finished loading and Electron
    // mirrored index.html's stale <title>PwrAgnt</title> onto the window, so
    // sampling the title before the renderer mounts would pass for the wrong
    // reason.
    const titles = await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => win.getTitle())
    );

    // Asserted by membership, not by the whole list: opening another
    // window during boot is someone else's feature, not this
    // regression. A single read, not a poll — the title must be right
    // once the renderer has loaded, and a retry loop would happily
    // pass on a sample taken before a later clobber.
    expect(titles).toContain("PwrAgent");
    expect(titles).not.toContain("PwrAgnt");
  } finally {
    await app.close();
  }
});
