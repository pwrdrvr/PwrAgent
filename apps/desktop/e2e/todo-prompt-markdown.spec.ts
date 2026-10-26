import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { StateDb } from "../src/main/state/state-db";
import { ThreadTodoStore } from "../src/main/thread-todos/thread-todo-store";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

// Entirely invented fixture data; these screenshots can be attached to a PR.
test("renders a Markdown to-do prompt and pastes the copied card as a quote", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-todo-markdown-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  const threadId = "fixture-build-memory";
  const threadTitle = "Build memory investigation";
  const prompt = "## Goal\n\nMeasure **heap usage** with `pnpm build`.\n\n- Record the peak\n- Compare the results\n\n```sh\npnpm build\n```";
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "todo-prompt-markdown", threadId },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "skills/list"],
      } },
      { id: "threads", kind: "response", method: "thread/list", result: [{
        id: threadId, title: threadTitle, titleSource: "explicit", summary: threadTitle, source: "codex",
        executionMode: "default", linkedDirectories: [], inbox: { inInbox: true, reason: "new-thread" }, updatedAt: 1_791_600_000_000,
      }] },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [], messages: [], threadStatus: "idle", pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
    ],
  }));
  const app = await launchElectronApp({
    fixturePath,
    contextRailPinned: false,
    preLaunchHook: async (homeRoot) => {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        new ThreadTodoStore(db).insert({
          id: "fixture-todo", backend: "codex", threadId, kind: "handoff", title: "Find the build memory peak",
          detail: "Identify a safe way to reduce build memory.", action: { type: "start_thread", prompt }, now: 1_791_600_000_000,
        });
      } finally {
        db.close();
      }
    },
  });
  try {
    await app.window.getByRole("button", { name: new RegExp(threadTitle) }).first().click();
    const card = app.window.getByRole("article", { name: "Find the build memory peak" });
    await expect(card).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath("prompt-collapsed.png") });
    await card.getByRole("button", { name: "Show the whole proposed prompt", exact: true }).click();
    const region = card.getByRole("region", { name: "Proposed prompt" });
    await expect(region.getByRole("heading", { name: "Goal", exact: true })).toBeVisible();
    await expect(region.locator("strong")).toHaveText("heap usage");
    await expect(region.locator("pre code")).toContainText("pnpm build");
    await card.screenshot({ path: testInfo.outputPath("prompt-expanded.png") });

    await card.getByRole("button", { name: "Copy to-do", exact: true }).click();
    await expect.poll(async () => (await app.getClipboardSnapshot())?.text).toContain(
      "### Prompt\n\n> ## Goal\n>\n> Measure **heap usage**",
    );
    const clipboard = await app.getClipboardSnapshot();
    expect(clipboard?.html).toContain("<blockquote>");
    const reply = app.window.getByRole("textbox", { name: "Reply", exact: true });
    await reply.focus();
    await app.window.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await expect(reply.locator("blockquote h2")).toHaveText("Goal");
    await expect(reply.locator("blockquote strong")).toHaveText("heap usage");
    await expect(reply.locator("blockquote pre code")).toContainText("pnpm build");
    await reply.screenshot({ path: testInfo.outputPath("copied-card-in-composer.png") });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
