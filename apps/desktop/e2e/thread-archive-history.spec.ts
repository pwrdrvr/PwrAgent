import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createArchiveHistoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-history-"));
  const threads = ["a", "b", "c"].map((id, index) => ({
    id: `history-${id}`, title: `History fixture ${id.toUpperCase()}`, titleSource: "explicit",
    source: "codex", executionMode: "default", linkedDirectories: [],
    inbox: { inInbox: true }, updatedAt: 1760000000000 - index,
  }));
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "thread-archive-history" },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "thread/archive", "thread/unarchive", "skills/list"],
      } },
      { id: "list", kind: "response", method: "thread/list", result: threads },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [{ type: "message", id: "fixture-message", role: "assistant", text: "Synthetic navigation history fixture." }],
        messages: [{ id: "fixture-message", role: "assistant", text: "Synthetic navigation history fixture." }],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "archive", kind: "response", method: "thread/archive", result: { threadId: "history-b" } },
      { id: "list-after", afterResponseId: "archive", kind: "response", method: "thread/list",
        result: threads.filter((thread) => thread.id !== "history-b") },
      { id: "archived-after", afterResponseId: "archive", archived: true,
        kind: "response", method: "thread/list", result: [threads[1]] },
    ],
  }));
  return { fixturePath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Back skips the archived thread after automatic fallback and Forward returns directly", async () => {
  const testInfo = test.info();
  const fixture = await createArchiveHistoryFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });
  try {
    const page = app.window;
    const sidebar = page.getByRole("complementary", { name: "Threads" });
    for (const id of ["A", "B"]) {
      await sidebar.getByRole("button", { name: `History fixture ${id}`, exact: true }).click();
      await expect(page.getByRole("heading", { level: 2, name: `History fixture ${id}` })).toBeVisible();
    }
    await expect(page.getByTestId("history-nav-back")).toHaveAttribute("aria-description", "History fixture A");
    // The title and history commit before the composer focus handoff.
    // Wait for the native shortcut's input target after switching threads.
    await expect(page.getByRole("textbox", { name: "Reply", exact: true })).toBeFocused();
    const nativeWindow = await app.electronApp.browserWindow(page);
    await nativeWindow.evaluate((window) => {
      const modifiers = [process.platform === "darwin" ? "meta" : "control", "shift"];
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace", modifiers });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace", modifiers });
    });
    await expect(sidebar.getByRole("button", { name: "History fixture B", exact: true })).toHaveCount(0);
    await expect(page.getByText("Thread archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "History fixture C" })).toBeVisible();
    await page.getByTestId("history-nav-back").click();
    await page.screenshot({ path: testInfo.outputPath("after-back.png") });
    await expect(page.getByRole("heading", { level: 2, name: "History fixture A" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("after-back-ready.png") });
    await expect(page.getByText("Select a thread", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("history-nav-forward")).toHaveAttribute("aria-description", "History fixture C");
    await page.getByTestId("history-nav-forward").click();
    await expect(page.getByRole("heading", { level: 2, name: "History fixture C" })).toBeVisible();
    await expect(page.getByTestId("history-nav-forward")).toBeDisabled();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
