import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/storage/thread-todo-store";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

test("Continue After holds merging until a thread is marked done, keeps the composer available, then reminds the operator", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-continue-after-hold-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "continue-after-hold-merge", threadId: "atlas-link" },
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
    await app.window.screenshot({ path: testInfo.outputPath("hold-merge-before.png") });
    await app.window.getByRole("button", { name: "Atlas: Windows MCP link", exact: true }).click({ button: "right" });
    await app.window.getByRole("menuitem", { name: "Continue After…", exact: true }).click();
    const dialog = app.window.getByRole("dialog", { name: "Continue After" });
    await dialog.getByRole("combobox", { name: "Find a thread to wait for" }).fill("validation");
    await dialog.getByRole("option", { name: /Atlas: Windows validation/ }).click();
    await expect(dialog.getByRole("button", { name: "Remove Atlas: Windows validation", exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "Continue when Atlas: Windows validation" }).click();
    await app.window.getByRole("option", { name: "Is marked done", exact: true }).click();
    // Waiting for something to be marked done holds merging unless unticked.
    await expect(dialog.getByRole("checkbox", { name: "Hold merging until then" })).toBeChecked();
    await dialog.getByRole("group", { name: "When met" }).getByRole("button", { name: "Remind me", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Remind me to" }).fill("Rebase onto the validation fix\nMerge PR #17");
    await app.window.screenshot({ path: testInfo.outputPath("hold-merge-form.png") });
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Mark Done… Atlas: Windows validation" })).toBeVisible();
    await expect(dialog).toContainText("Merge held");
    await expect(dialog).toContainText("Rebase onto the validation fix");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(app.window.locator(".continue-after-status")).toContainText("Merge held until Atlas: Windows validation");
    await expect(app.window.getByRole("button", { name: "Continue after: Merge held", exact: true })).toBeVisible();
    await expect(stack.getByRole("button", { name: "Squash merge", exact: true })).toHaveCount(0);
    await expect(stack).toContainText("Merge waits for Atlas: Windows validation");
    const reply = app.window.getByRole("textbox", { name: "Reply", exact: true });
    await expect(reply).toBeEditable();
    await reply.fill("Rebase the branch and repair CI while validation continues.");
    const refusal = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      try { return (await api.runThreadTodoAction!({ id: "atlas-merge-card" })).todo.error ?? "unexpectedly merged"; }
      catch (error) { return String(error); }
    });
    expect(refusal).toContain("Merge held");
    await app.window.screenshot({ path: testInfo.outputPath("hold-merge-held.png") });
    await app.window.locator(".continue-after-status").getByRole("button", { name: "Continue After…", exact: true }).click();
    await dialog.getByRole("button", { name: "Mark Done… Atlas: Windows validation" }).click();
    await dialog.getByRole("textbox", { name: "What finished (optional)" }).fill("Windows validation passed on the fix.");
    await app.window.screenshot({ path: testInfo.outputPath("hold-merge-mark-done.png") });
    await dialog.getByRole("button", { name: "Mark Done", exact: true }).click();
    // The toggle's CSS caret is part of its accessible name ("▸ History (1)").
    await expect(dialog.getByRole("button", { name: /History \(1\)$/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(app.window.locator(".continue-after-status")).toHaveCount(0);
    // Marking it done reminds the operator of the steps; it starts no turn.
    await expect(stack).toContainText(/done: Rebase onto the validation fix \(\+1 more\)/);
    await expect(stack).toContainText("Windows validation passed on the fix.");
    await expect(stack).toContainText("Merge PR #17");
    await app.window.screenshot({ path: testInfo.outputPath("hold-merge-reminder.png") });
    await expect(stack.getByRole("checkbox", { name: "Merge PR #17" })).not.toBeChecked();
    // The merge card is the next page of the stack, and it can merge again.
    await stack.getByRole("button", { name: "Next to-do" }).click();
    await expect(stack.getByRole("button", { name: /Squash merge|Retry merge/ }).first()).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
