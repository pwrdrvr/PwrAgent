import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { StateDb } from "../src/main/state/state-db";
import { recordModelSettingsRecent } from "../src/main/state/model-settings-recents-store";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/storage/thread-todo-store";

/**
 * Where a chip sits in its facts row, in CSS pixels: the model pill or a
 * fact dropdown such as Where.
 */
async function measureModelChip(chip: Locator) {
  return chip.evaluate((element) => {
    const value = element.closest("dd");
    const label = element.querySelector(".model-settings__pill-model, .composer-dropdown__label");
    const term = value?.previousElementSibling;
    if (!value || !label || !term) throw new Error("Missing chip fact parts");
    const chip = element.getBoundingClientRect();
    const valueBox = value.getBoundingClientRect();
    const termBox = term.getBoundingClientRect();
    // The span its children cover plus padding and border: what the chip
    // would be if it only wrapped them. A stretched chip is wider than this.
    const parts = [...element.children].map((child) => child.getBoundingClientRect())
      .filter((box) => box.width > 0);
    const style = getComputedStyle(element);
    const frame = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
      .reduce((sum, key) => sum + Number.parseFloat(style[key as "paddingLeft"]), 0);
    return {
      chipWidth: chip.width,
      chipRight: chip.right,
      contentWidth: Math.max(...parts.map((box) => box.right)) - Math.min(...parts.map((box) => box.left)) + frame,
      labelTruncated: label.scrollWidth > label.clientWidth,
      valueWidth: valueBox.width,
      valueRight: valueBox.right,
      termCenterOffset: Math.abs((chip.top + chip.bottom) / 2 - (termBox.top + termBox.bottom) / 2),
    };
  });
}

/**
 * The chip hugs its contents: it is as wide as its provider, model, effort
 * and chevron, never stretched across the value column, which a
 * `width: 100%` chip once was. It also stays inside that column.
 */
function expectChipHugsLabel(layout: Awaited<ReturnType<typeof measureModelChip>>) {
  expect(layout.labelTruncated).toBe(false);
  expect(Math.abs(layout.chipWidth - layout.contentWidth)).toBeLessThanOrEqual(2);
  expect(layout.chipRight).toBeLessThanOrEqual(layout.valueRight + 0.5);
  expect(layout.termCenterOffset).toBeLessThanOrEqual(1.5);
}

/**
 * Opens the labelled grid on the first card in `scope` that is still
 * showing the chip row. The choice is per card and shared by the stack and
 * the To-dos panel, so a card opened in one is already open in the other.
 */
async function showStartSettings(scope: Locator) {
  const toggle = scope.getByRole("button", { name: "Show start settings" }).first();
  if (await toggle.count() > 0) await toggle.click();
  await expect(scope.getByRole("button", { name: "Hide start settings labels" }).first()).toBeVisible();
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
    await expect(chip).toHaveAccessibleName(/GPT-5.5, high effort/);
    // At rest the settings are a chip row; the grid's geometry is measured open.
    await expect(stack.getByRole("group", { name: "Start settings" })).toBeVisible();
    await showStartSettings(stack);
    const stackLayout = await measureModelChip(chip);
    expectChipHugsLabel(stackLayout);
    await chip.click();
    const menu = app.window.getByRole("dialog", { name: "Model for the new thread", exact: true });
    const readyRows = menu.getByRole("listbox", { name: "Ready settings" }).getByRole("option");
    await expect(readyRows.first()).toBeFocused();
    // The panel fills in after it opens: the Recent rows and the provider
    // come from requests still in flight. "GPT-5.4" alone was also in the
    // catalog shown before them, so on a slow Windows runner ArrowDown ran
    // before the row it moves to existed, and focus stayed put.
    const recentXhigh = menu.getByRole("option", { name: /GPT-5.5, xhigh effort/ });
    await expect(recentXhigh).toBeVisible();
    await expect(menu.getByRole("listbox", { name: "Provider" }).getByRole("option", { name: "OpenAI" })).toBeVisible();
    await expect(menu).toContainText("GPT-5.4");
    // The panel opens beside the chip (under it when it fits, else above),
    // never over it, and stays inside the window.
    const menuBox = await menu.boundingBox();
    const chipBox = await chip.boundingBox();
    const viewportWidth = await app.window.evaluate(() => window.innerWidth);
    expect(menuBox!.y >= chipBox!.y + chipBox!.height || menuBox!.y + menuBox!.height <= chipBox!.y).toBe(true);
    expect(menuBox!.x).toBeGreaterThanOrEqual(8);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewportWidth - 8 + 0.5);
    await menu.screenshot({ path: testInfo.outputPath("todo-dispatch-popover.png"), animations: "disabled" });
    await readyRows.first().press("ArrowDown");
    await expect(recentXhigh).toBeFocused();
    await app.window.keyboard.press("Enter");
    await expect(menu).not.toBeVisible();
    await expect(chip).toHaveAccessibleName(/GPT-5.5, xhigh effort/);
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
    await showStartSettings(panel.locator(".thread-todo-card").first());
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
    // Where is a chip too: it stays in its column on one line, centered on
    // its label, and truncates instead of wrapping.
    const whereChip = panel.getByRole("button", { name: /^Where the new thread works:/ }).first();
    const where = await measureModelChip(whereChip);
    expect(where.chipRight).toBeLessThanOrEqual(where.valueRight + 0.5);
    expect(where.termCenterOffset).toBeLessThanOrEqual(1.5);
    expect((await whereChip.boundingBox())!.height).toBeLessThanOrEqual(26);
    await panel.locator(".thread-todo-card").first().screenshot({
      path: testInfo.outputPath("todo-dispatch-panel-narrow.png"), animations: "disabled",
    });
    await panel.locator(".thread-todos-panel").evaluate((element) => { element.style.width = ""; });
    // The panel's body scrolls under its fixed lens switch.
    await panel.locator(".thread-todos-panel__body").evaluate((element) => { element.style.paddingTop = "900px"; });
    const panelChip = panel.getByRole("button", { name: /^Model for the new thread:/ }).first();
    await panelChip.evaluate((element) => {
      const scroller = element.closest<HTMLElement>(".thread-todos-panel__body");
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
    await readyRows.first().press("End");
    await expect(readyRows.last()).toBeFocused();
    await app.window.keyboard.press("Escape");
    await todosTab.click();
    await expect(panel).not.toBeVisible();
    await app.window.screenshot({ path: testInfo.outputPath("todo-start-thread.png") });
    await stack.getByRole("button", { name: "Handoff options" }).click();
    // The split menu floats on the body, outside the stack.
    await app.window.getByRole("menu", { name: "Handoff options" })
      .getByRole("menuitemradio", { name: "Send to thread…" }).click();
    await expect(stack.getByRole("button", { name: "Send request", exact: true })).toBeDisabled();
    // The ⌘K palette's search, as you type: no Search button, and Enter picks
    // the active row.
    const destinationField = stack.getByRole("combobox", { name: "Find destination thread" });
    await destinationField.fill("Per-route rate limits");
    await expect(stack.getByRole("option", { name: /Per-route rate limits/ })).toBeVisible();
    await expect(stack.getByRole("button", { name: "Search", exact: true })).toHaveCount(0);
    await destinationField.press("Enter");
    await expect(stack.getByRole("button", { name: "Send request", exact: true })).toBeEnabled();
    // The destination is a thread chip; its hover card names the thread id.
    const destination = stack.getByRole("button", { name: "Open thread Per-route rate limits", exact: true });
    await destination.focus();
    await expect(app.window.getByRole("tooltip")).toContainText(other);
    await destination.blur();
    expect(await app.getLastStartTurn()).toBeUndefined();
    await stack.getByRole("button", { name: "Show the whole proposed prompt" }).click();
    await app.window.screenshot({ path: testInfo.outputPath("todo-send-request.png") });
    await stack.getByRole("button", { name: "Handoff options" }).click();
    await app.window.getByRole("menu", { name: "Handoff options" })
      .getByRole("menuitemradio", { name: "Start a new thread" }).click();
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
