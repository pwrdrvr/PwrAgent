import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("updates the Waiting for badge, cancels through the owner, and loads ended history", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/context-rail-linked-directory-tooltips/replay.fixture.json"),
    windowSize: { width: 1280, height: 820 },
  });
  try {
    await app.window.getByRole("button", { name: /Linked directory tooltip thread/i }).first().click();
    await expect(app.window.getByRole("heading", { level: 2, name: "Linked directory tooltip thread" })).toBeVisible();
    await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      await api.createScheduledThreadAction!({ backend: "codex", threadId: "thread-linked-directory-tooltips",
        kind: "turn", origin: "desktop", scheduledFor: Date.now() + 86_400_000,
        displayText: "Schedule fixture follow-up", turn: { input: [{ type: "text", text: "Schedule fixture follow-up" }] } });
    });
    const rail = app.window.getByRole("complementary", { name: "Thread context" });
    const waiting = rail.getByRole("tab", { name: /Waiting for/ });
    await expect(waiting).toHaveAttribute("aria-label", "Waiting for · 1 pending wake");
    await waiting.click();
    await expect(rail.getByText(/Schedule fixture follow-up/)).toBeVisible();
    await rail.getByRole("button", { name: /^Cancel: Message/ }).click();
    await expect(rail.getByText("Nothing will wake this thread.")).toBeVisible();
    await expect(waiting).toHaveAttribute("aria-label", "Waiting for");
    await rail.getByRole("button", { name: /Recently ended/ }).click();
    await expect(rail.getByText("Scheduled message cancelled", { exact: false })).toBeVisible();
  } finally {
    await app.close();
  }
});
