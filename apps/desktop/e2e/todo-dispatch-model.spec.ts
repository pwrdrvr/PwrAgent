import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { StateDb } from "../src/main/state/state-db";
import { recordModelSettingsRecent } from "../src/main/state/model-settings-recents-store";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/thread-todos/thread-todo-store";
import { ROW_CHECK_INSET } from "../src/renderer/src/features/thread-todos/todo-model-menu-placement";

/** Where the Model chip sits in its facts row, in CSS pixels. */
async function measureModelChip(chip: Locator) {
  return chip.evaluate((element) => {
    const value = element.closest("dd");
    const label = element.querySelector(".composer-dropdown__label");
    const term = value?.previousElementSibling;
    const facts = element.closest(".thread-todo-card__facts");
    if (!value || !label || !term || !facts) throw new Error("Missing Model fact parts");
    const chip = element.getBoundingClientRect();
    const valueBox = value.getBoundingClientRect();
    const termBox = term.getBoundingClientRect();
    return {
      chipWidth: chip.width,
      chipRight: chip.right,
      labelWidth: label.scrollWidth,
      labelTruncated: label.scrollWidth > label.clientWidth,
      valueWidth: valueBox.width,
      valueRight: valueBox.right,
      termCenterOffset: Math.abs((chip.top + chip.bottom) / 2 - (termBox.top + termBox.bottom) / 2),
      factsLeft: facts.getBoundingClientRect().left,
    };
  });
}

/**
 * The chip hugs its label: padding, gap, chevron and border add about 35px.
 * `.composer-dropdown__button` sets `width: 100%`, which stretched the chip
 * across the whole value column once.
 */
function expectChipHugsLabel(layout: Awaited<ReturnType<typeof measureModelChip>>) {
  expect(layout.labelTruncated).toBe(false);
  expect(layout.chipWidth).toBeLessThanOrEqual(layout.labelWidth + 40);
  expect(layout.chipWidth).toBeLessThan(layout.valueWidth - 40);
  expect(layout.termCenterOffset).toBeLessThanOrEqual(1.5);
}

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
    const stackLayout = await measureModelChip(chip);
    expectChipHugsLabel(stackLayout);
    await chip.click();
    const menu = app.window.getByRole("menu", { name: "Model for the new thread", exact: true });
    await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
    await expect(menu).toContainText("GPT-5.4");
    // The menu hangs under the card's facts, not off the chip.
    const menuBox = await menu.boundingBox();
    expect(menuBox?.width).toBeCloseTo(312, 0);
    expect(Math.abs((menuBox?.x ?? 0) - (stackLayout.factsLeft - ROW_CHECK_INSET))).toBeLessThanOrEqual(1);
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
    // Add scrollable fixture space, then put a real To-dos-panel chip at
    // the bottom edge without moving it outside its clipping ancestors.
    const todosTab = app.window.getByRole("tab", { name: /^To-dos/ });
    await todosTab.click();
    const panel = app.window.getByRole("tabpanel", { name: /^To-dos/ });
    await expect(panel.locator(".thread-todo-card")).toHaveCount(2);
    const firstPanelChip = panel.getByRole("button", { name: /^Model for the new thread:/ }).first();
    // The rail's width follows the window: about 220px in CI's 1024px
    // window, which truncates the label. Either way the chip stays in its
    // column, and it hugs the label whenever the label fits.
    const panelLayout = await measureModelChip(firstPanelChip);
    expect(panelLayout.chipRight).toBeLessThanOrEqual(panelLayout.valueRight + 0.5);
    if (!panelLayout.labelTruncated) expectChipHugsLabel(panelLayout);
    await panel.locator(".thread-todo-card").first().screenshot({
      path: testInfo.outputPath("todo-dispatch-panel.png"), animations: "disabled",
    });
    // A narrow panel truncates the label inside the chip instead of
    // overflowing the card.
    await panel.locator(".thread-todos-panel").evaluate((element) => { element.style.width = "220px"; });
    await expect.poll(async () => (await measureModelChip(firstPanelChip)).labelTruncated).toBe(true);
    const narrowLayout = await measureModelChip(firstPanelChip);
    expect(narrowLayout.chipRight).toBeLessThanOrEqual(narrowLayout.valueRight + 0.5);
    expect(narrowLayout.termCenterOffset).toBeLessThanOrEqual(1.5);
    // A wrapped value keeps its label on the first line.
    const whereFact = panel.locator(".thread-todo-card").first().locator(".thread-todo-card__fact", { hasText: "Where" });
    const where = await whereFact.evaluate((element) => {
      const text = (node: Element) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      };
      const term = text(element.querySelector("dt")!);
      const value = text(element.querySelector("dd")!);
      return { termTop: term.top, termHeight: term.height, valueTop: value.top, valueHeight: value.height };
    });
    expect(where.valueHeight).toBeGreaterThan(where.termHeight);
    expect(Math.abs(where.termTop - where.valueTop)).toBeLessThanOrEqual(1);
    await panel.locator(".thread-todo-card").first().screenshot({
      path: testInfo.outputPath("todo-dispatch-panel-narrow.png"), animations: "disabled",
    });
    await panel.locator(".thread-todos-panel").evaluate((element) => { element.style.width = ""; });
    await panel.locator(".thread-todos-panel").evaluate((element) => { element.style.paddingTop = "900px"; });
    const panelChip = panel.getByRole("button", { name: /^Model for the new thread:/ }).first();
    await panelChip.evaluate((element) => {
      const scroller = element.closest<HTMLElement>(".context-panel__scroll");
      if (!scroller) throw new Error("Missing To-dos scroll container");
      scroller.scrollTop += element.getBoundingClientRect().top - (window.innerHeight - 50);
    });
    await expect.poll(async () => {
      const anchor = await panelChip.boundingBox();
      const viewportHeight = await app.window.evaluate(() => window.innerHeight);
      return Boolean(anchor && anchor.y >= viewportHeight - 80 && anchor.y + anchor.height <= viewportHeight - 8);
    }).toBe(true);
    await panelChip.click();
    await expect(menu).toBeVisible();
    await expect.poll(async () => {
      const bounds = await menu.boundingBox();
      const anchor = await panelChip.boundingBox();
      const viewportHeight = await app.window.evaluate(() => window.innerHeight);
      return Boolean(bounds && anchor && bounds.y >= 8 && bounds.y + bounds.height <= viewportHeight - 8
        && bounds.y + bounds.height <= anchor.y);
    }).toBe(true);
    await menu.getByRole("menuitemradio").first().press("End");
    await expect(menu.getByRole("menuitem", { name: /To-do reasoning:/ })).toBeFocused();
    await app.window.keyboard.press("Escape");
    await todosTab.click();
    await expect(panel).not.toBeVisible();
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
