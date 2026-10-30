import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/thread-todos/thread-todo-store";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

test("holds merging while the composer stays available, then clears with findings", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-merge-holds-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "merge-holds", threadId: "atlas-link" },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: { serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "skills/list", "turn/start"] } },
      { id: "threads", kind: "response", method: "thread/list", result: [
        { id: "atlas-link", title: "Atlas: Windows MCP link", source: "codex", linkedDirectories: [], updatedAt: 1_791_600_000_000 },
        { id: "atlas-validation", title: "Atlas: Windows validation", source: "codex", linkedDirectories: [], updatedAt: 1_791_599_000_000 },
      ] },
      { id: "read", kind: "response", method: "thread/read", result: { entries: [{ type: "message", id: "summary", role: "assistant", text: "The MCP link is ready. Windows validation is still being investigated in the other thread.", createdAt: 1_791_600_000_000 }], messages: [], threadStatus: "idle", pagination: { supportsPagination: false, hasPreviousPage: false } } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
      { id: "turn", kind: "response", method: "turn/start", result: { threadId: "atlas-link", turnId: "repair-turn" } },
    ],
  }));
  const app = await launchElectronApp({ fixturePath, contextRailPinned: false,
    preLaunchHook: async (homeRoot) => {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const todos = new ThreadTodoService({ store: new ThreadTodoStore(db), newId: () => "atlas-merge-card" });
        todos.add({ backend: "codex", threadId: "atlas-link", input: { title: "Merge Atlas PR #17", action: { type: "merge_pull_request", pullRequest: "https://github.com/atlas-fixture/desktop/pull/17" } } });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: "Atlas: Windows MCP link", exact: true }).click();
    const stack = app.window.getByRole("region", { name: "To-dos for this thread" });
    await expect(stack.getByRole("button", { name: "Squash merge", exact: true })).toBeVisible();
    await app.window.screenshot({ path: testInfo.outputPath("merge-hold-before.png") });
    await app.window.getByRole("button", { name: "Atlas: Windows MCP link", exact: true }).click({ button: "right" });
    await app.window.getByRole("menuitem", { name: "Hold Merge…", exact: true }).click();
    const dialog = app.window.getByRole("dialog", { name: "Merge holds" });
    await dialog.getByRole("textbox", { name: "Hold merge because" }).fill("Waiting for Windows validation");
    await dialog.getByRole("textbox", { name: "Release when" }).fill("Reconcile the investigation findings with PR #17");
    await dialog.getByRole("textbox", { name: "Waiting on (optional thread link)" }).fill("pwragent://thread/atlas-validation?backend=codex");
    await dialog.getByRole("button", { name: "Hold merge", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Resolve hold…" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(app.window.locator(".thread-merge-holds__status")).toContainText("Merge held");
    await expect(app.window.getByLabel("Merge held: Waiting for Windows validation", { exact: true })).toBeVisible();
    await expect(stack.getByRole("button", { name: "Squash merge", exact: true })).toHaveCount(0);
    await expect(stack).toContainText("Merge held: Waiting for Windows validation");
    const reply = app.window.getByRole("textbox", { name: "Reply", exact: true });
    await expect(reply).toBeEditable();
    await reply.fill("Rebase the branch and repair CI while validation continues.");
    const refusal = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      try { return (await api.runThreadTodoAction!({ id: "atlas-merge-card" })).todo.error ?? "unexpectedly merged"; }
      catch (error) { return String(error); }
    });
    expect(refusal).toContain("Merge held");
    await app.window.screenshot({ path: testInfo.outputPath("merge-hold-after.png") });
    await app.window.getByRole("button", { name: "Manage holds", exact: true }).click();
    await dialog.getByRole("button", { name: "Resolve hold…" }).click();
    await dialog.getByRole("textbox", { name: "Findings or reason for clearing" }).fill("Windows validation passed and its findings are reconciled.");
    await app.window.screenshot({ path: testInfo.outputPath("merge-hold-resolve.png") });
    await dialog.getByRole("button", { name: "Resolve hold", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Show history" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(app.window.locator(".thread-merge-holds__status")).toHaveCount(0);
    await expect(stack.getByRole("button", { name: /Squash merge|Retry merge/ }).first()).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
