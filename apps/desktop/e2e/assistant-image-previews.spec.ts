import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

function markdownImagePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function expectLoaded(image: Locator): Promise<void> {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth > 0;
  })).toBe(true);
}

test("previews replies and native image views live, then reopens retained images in the gallery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-assistant-previews-"));
  const worktreeRoot = path.resolve(specDir, "../../../.local");
  await mkdir(worktreeRoot, { recursive: true });
  const worktree = await mkdtemp(path.join(worktreeRoot, "image-preview-worktree-"));
  const imageFixture = path.join(specDir, "fixtures/thread-image-fit/thread-image.png");
  const mockup = path.join(worktree, "mockup.png");
  const screenshot = path.join(root, "screenshot.png");
  const native = path.join(root, "native.png");
  await Promise.all([copyFile(imageFixture, mockup), copyFile(imageFixture, screenshot), copyFile(imageFixture, native)]);
  const threadId = "assistant-previews";
  const turnId = "preview-turn";
  const text = `Here is the mockup.\n\n![Mockup](${markdownImagePath(mockup)})\n\n![Repeated mockup](${markdownImagePath(mockup)})\n\n![Screenshot](${markdownImagePath(screenshot)})\n\n![Missing](${markdownImagePath(path.join(root, "missing.png"))})`;
  const message = { type: "message", id: "reply", role: "assistant", text };
  const nativeParams = { threadId, turnId, completedAtMs: 1, item: { type: "imageView", id: "native-view", path: native } };
  const replay = {
    entries: [message, { type: "activity", id: "activity-native", summary: "Viewed image", status: "completed", details: [{
      id: "native-view", kind: "command", label: `View image: ${native}`, status: "completed",
      images: [{ type: "image", url: pathToFileURL(native).toString(), sourceUrl: pathToFileURL(native).toString(), alt: path.basename(native) }],
    }] }],
    messages: [message], pagination: { supportsPagination: false, hasPreviousPage: false },
  };
  const fixturePath = path.join(root, "previews.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "assistant-image-previews", threadId },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: { methods: ["thread/list", "thread/read"] } },
      { id: "list", kind: "response", method: "thread/list", result: [{
        id: threadId, title: "Assistant image previews", titleSource: "explicit", source: "codex", updatedAt: Date.now(),
        executionMode: "default", inbox: { inInbox: true, reason: "new-thread" },
        linkedDirectories: [{ id: "preview-worktree", label: "Preview worktree", path: worktree, worktreePath: worktree, kind: "worktree" }],
      }] },
      { id: "read-empty", kind: "response", method: "thread/read", result: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } } },
      { id: "started", kind: "notification", notification: { method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } } },
      { id: "reply", kind: "notification", notification: { method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "reply", text } } } },
      { id: "native-view", kind: "notification", notification: { method: "item/completed", params: nativeParams } },
      { id: "native-again", kind: "notification", notification: { method: "item/completed", params: nativeParams } },
      { id: "completed", kind: "notification", notification: { method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", output: [] } } } },
      { id: "read-complete", kind: "response", method: "thread/read", result: replay },
    ],
  }));
  const app = await launchElectronApp({ fixturePath, windowSize: { width: 1280, height: 900 } });
  try {
    await app.window.getByRole("button", { name: /Assistant image previews/i }).first().click();
    await app.advance({ stepId: "started" });
    await app.advance({ stepId: "reply" });
    await expectLoaded(app.window.getByAltText("Mockup", { exact: true }));
    await expect(app.window.locator(".transcript-message__image-preview")).toHaveCount(2);
    await expect(app.window.locator(".thread-markdown__image-literal")).toHaveText([`![Missing](${markdownImagePath(path.join(root, "missing.png"))})`]);
    await expectLoaded(app.window.getByAltText("Screenshot", { exact: true }));
    await app.advance({ stepId: "native-view" });
    await app.advance({ stepId: "native-again" });
    await expectLoaded(app.window.getByAltText("native.png", { exact: true }));
    await expect(app.window.locator(".transcript-activity__image")).toHaveCount(1);
    const nativeSource = await app.window.getByAltText("native.png").getAttribute("src");
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.advance({ stepId: "completed" });
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    await Promise.all([rm(mockup), rm(screenshot), rm(native)]);
    await app.window.reload();
    await app.window.getByRole("button", { name: /Assistant image previews/i }).first().click();
    await expectLoaded(app.window.getByAltText("Mockup", { exact: true }));
    await expectLoaded(app.window.getByAltText("Screenshot", { exact: true }));
    await expectLoaded(app.window.getByAltText("native.png", { exact: true }));
    await expect(app.window.getByAltText("native.png")).toHaveAttribute("src", nativeSource!);
    await app.window.getByRole("button", { name: /^Expand transcript image/ }).first().click();
    const gallery = app.window.getByRole("dialog", { name: "Expanded image", exact: true });
    await expect(gallery).toBeVisible();
    await expect(gallery).toContainText("Image 1 of 3");
    await gallery.getByRole("button", { name: "Next image", exact: true }).click();
    await expect(gallery).toContainText("Image 2 of 3");
    await gallery.getByRole("button", { name: "Next image", exact: true }).click();
    await expect(gallery).toContainText("Image 3 of 3");
    await expectLoaded(gallery.locator("img"));
    await gallery.getByRole("button", { name: "Close", exact: true }).click();
  } finally {
    await app.close();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(worktree, { recursive: true, force: true })]);
  }
});
