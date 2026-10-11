import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createArchiveShortcutFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-archive-shortcut-"));
  const repo = path.join(root, "FixtureRepo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=PwrAgent Tests", "-c",
    "user.email=pwragent-tests@example.invalid", "commit", "--allow-empty", "-m", "Seed fixture"],
  { cwd: repo, stdio: "ignore" });
  const thread = {
    id: "thread-archive-shortcut", title: "Archive shortcut fixture", titleSource: "explicit",
    summary: "Contrived archive shortcut thread", source: "codex", executionMode: "default",
    linkedDirectories: [{ id: `directory:${repo}`, label: "FixtureRepo", path: repo, kind: "local" }],
    inbox: { inInbox: true }, updatedAt: 1760000000000,
  };
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "thread-archive-shortcut" },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" },
        methods: ["thread/list", "thread/read", "thread/archive", "skills/list"],
      } },
      { id: "list", kind: "response", method: "thread/list", result: [thread] },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [{ type: "message", id: "message-1", role: "assistant", text: "Ready to archive." }],
        messages: [{ id: "message-1", role: "assistant", text: "Ready to archive." }],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "archive", kind: "response", method: "thread/archive", result: { threadId: thread.id } },
      { id: "list-after", afterResponseId: "archive", kind: "response", method: "thread/list", result: [] },
      { id: "archived-after", afterResponseId: "archive", archived: true,
        kind: "response", method: "thread/list", result: [thread] },
    ],
  }));
  return { fixturePath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const focus of ["focused empty", "focused draft", "unfocused"] as const) {
  test(`native archive shortcut works with ${focus} composer`, async () => {
    const fixture = await createArchiveShortcutFixture();
    const app = await launchElectronApp({ fixturePath: fixture.fixturePath });
    try {
      const row = app.window.getByRole("button", { name: "Archive shortcut fixture", exact: true });
      await row.click();
      const editor = app.window.getByRole("textbox", { name: "Reply", exact: true });
      // Opening a thread must retain the existing autofocus flow.
      await expect(editor).toBeFocused();
      if (focus === "focused draft") {
        await editor.fill("Keep this unsent draft");
        await editor.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
        await expect(editor).toHaveText("Keep this unsent draft");
        await expect.poll(() => editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(0);
      }
      if (focus === "unfocused") {
        await editor.evaluate((element) => (element as HTMLElement).blur());
        await expect(editor).not.toBeFocused();
      }
      // Main-process sendInputEvent goes through Chromium's native key path,
      // including keyCode 8 and any Electron menu accelerator interception.
      // DOM dispatchEvent alone misses ProseMirror's native deletion guard.
      const nativeWindow = await app.electronApp.browserWindow(app.window);
      await nativeWindow.evaluate((window) => {
        const modifiers = [process.platform === "darwin" ? "meta" : "control", "shift"];
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Backspace", modifiers });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Backspace", modifiers });
      });
      await expect(row).toHaveCount(0);
      await expect(app.window.getByText("Thread archived", { exact: true })).toHaveCount(1);
      await expect(app.window.getByRole("button", { name: "Undo", exact: true })).toHaveCount(1);
    } finally {
      await app.close();
      await fixture.cleanup();
    }
  });
}
