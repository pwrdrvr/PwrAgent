import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { StateDb } from "../src/main/state/state-db";
import { recordModelSettingsRecent } from "../src/main/state/model-settings-recents-store";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/thread-todos/thread-todo-store";

/** Contrived Atlas data only; also captures the before/after PR illustrations. */
test("picks dispatch settings with the keyboard and remembers them on the raising thread", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-todo-model-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  const source = "atlas-webhooks";
  const other = "atlas-rate-limits";
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "todo-dispatch-model", threadId: source },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "thread/start", "turn/start", "skills/list"],
      } },
      { id: "threads", kind: "response", method: "thread/list", result: [
        { id: source, title: "Webhook delivery hardening", summary: "Cache signing keys and bound delivery retries", source: "codex",
          executionMode: "default", model: "gpt-5.5", reasoningEffort: "high", linkedDirectories: [], updatedAt: 1_791_600_000_000 },
        { id: other, title: "Per-route rate limits", summary: "Keep tenant budgets separate", source: "codex",
          executionMode: "default", model: "gpt-5.5", reasoningEffort: "high", linkedDirectories: [], updatedAt: 1_791_599_000_000 },
      ] },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [{ type: "message", id: "summary", role: "assistant", text: "The delivery path is ready. I raised the remaining work as to-dos.", createdAt: 1_791_600_000_000 }],
        messages: [], threadStatus: "idle", pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
      { id: "start", kind: "response", method: "thread/start", result: { threadId: "atlas-cache-worker" } },
      { id: "turn", kind: "response", method: "turn/start", result: { threadId: "atlas-cache-worker", turnId: "cache-turn" } },
    ],
  }));
  const app = await launchElectronApp({
    fixturePath, contextRailPinned: false,
    preLaunchHook: async (homeRoot) => {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        let ids = 0;
        const todos = new ThreadTodoService({ store: new ThreadTodoStore(db), now: () => 1_791_600_000_000, newId: () => `atlas-card-${++ids}` });
        for (const [threadId, titles] of [[source, ["Bound the retry queue", "Cache the signing-key lookup"]], [other, ["Separate tenant rate budgets"]]] as const) {
          db.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run(`codex:${threadId}`, JSON.stringify({
            backend: "codex", threadId, executionMode: "default", model: "gpt-5.5", reasoningEffort: "high", extraLinkedDirectories: [],
          }));
          for (const title of titles) todos.add({ backend: "codex", threadId,
            sourceProject: { key: "directory:atlas", label: "atlas", path: "/example/atlas" },
            input: { title,
              detail: "Every delivery re-reads the signing key. Cache it per tenant with a short TTL and drop the entry on rotation.",
              action: { type: "start_thread", prompt: "Cache the signing-key lookup per tenant. Invalidate the cache when a key rotates." },
            },
          });
        }
        recordModelSettingsRecent(db, "todo-dispatch", { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" });
        recordModelSettingsRecent(db, "todo-dispatch", { backend: "codex", model: "gpt-5.5", reasoningEffort: "xhigh" });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    await app.window.getByRole("button", { name: "Webhook delivery hardening", exact: true }).click();
    const stack = app.window.getByRole("region", { name: "To-dos for this thread" });
    await expect(stack.getByRole("button", { name: "Start thread", exact: true })).toBeVisible();
    await expect.poll(() => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.listBackends!()).backends.find((backend) => backend.kind === "codex")?.available;
    })).toBe(true);
    if (process.env.PWRAGENT_TODO_DISPATCH_BEFORE === "1") {
      await stack.screenshot({ path: testInfo.outputPath("todo-dispatch-before.png"), animations: "disabled" });
      return;
    }
    const chip = stack.getByRole("button", { name: /Model for the new thread:/ });
    await expect(chip).toHaveAccessibleName(/GPT-5.5, high/);
    await chip.click();
    const menu = app.window.getByRole("menu", { name: "Model for the new thread", exact: true });
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
    await expect(menu).toContainText("GPT-5.4");
    await menu.screenshot({ path: testInfo.outputPath("todo-dispatch-popover.png"), animations: "disabled" });
    await menu.getByRole("menuitemradio").first().press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: /GPT-5.5 · xhigh/ })).toBeFocused();
    await app.window.keyboard.press("Enter");
    await expect(menu).not.toBeVisible();
    await expect(chip).toHaveAccessibleName(/GPT-5.5, xhigh/);
    await expect(stack).toContainText("Picked for this card");
    await stack.getByRole("heading", { name: "Cache the signing-key lookup", exact: true }).click();
    await expect(app.window.locator(".data-tooltip-layer")).not.toBeVisible();
    await stack.screenshot({ path: testInfo.outputPath("todo-dispatch-after.png"), animations: "disabled" });
    await stack.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect.poll(() => app.getLastStartTurn()).toMatchObject({ model: "gpt-5.5", reasoningEffort: "xhigh" });
    await expect(stack).toContainText("Last used in this thread");
    await app.window.reload();
    await app.window.getByRole("button", { name: "Webhook delivery hardening", exact: true }).click();
    await expect(app.window.getByRole("region", { name: "To-dos for this thread" })).toContainText("Last used in this thread");
    const cards = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.listThreadTodos!()).todos;
    });
    expect(cards.find((card) => card.threadId === source)?.dispatchDefaults?.lastDispatch)
      .toMatchObject({ backend: "codex", model: "gpt-5.5", reasoningEffort: "xhigh" });
    expect(cards.find((card) => card.threadId === other)?.dispatchDefaults?.lastDispatch).toBeUndefined();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
