import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { accessTrigger } from "./fixtures/access-picker";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { StateDb } from "../src/main/state/state-db";
import { ThreadTodoService } from "../src/main/thread-todos/thread-todo-service";
import { ThreadTodoStore } from "../src/main/storage/thread-todo-store";

/**
 * A to-do card that starts its thread at Full Access still goes through the
 * "Enable Full Access?" modal from `useExecutionModeSelection`; the composer
 * confirms inline instead. Contrived Atlas data only.
 */
test("confirms a to-do card's Full Access start in the Enable Full Access modal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-todo-full-access-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  const source = "atlas-webhooks";
  const started = "atlas-key-rotation";
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "todo-full-access-confirmation", threadId: source },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "thread/start", "turn/start", "skills/list"],
      } },
      { id: "threads", kind: "response", method: "thread/list", result: [
        { id: source, title: "Webhook delivery hardening", summary: "Cache signing keys and bound delivery retries", source: "codex",
          executionMode: "default", model: "gpt-5.5", reasoningEffort: "high", linkedDirectories: [], updatedAt: 1_791_600_000_000 },
      ] },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [{ type: "message", id: "summary", role: "assistant", text: "Rotating the signing keys needs network access, so I raised it as a to-do.", createdAt: 1_791_600_000_000 }],
        messages: [], threadStatus: "idle", pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
      { id: "start", kind: "response", method: "thread/start", result: { threadId: started } },
      { id: "turn", kind: "response", method: "turn/start", result: { threadId: started, turnId: "rotation-turn" } },
    ],
  }));
  const app = await launchElectronApp({
    fixturePath, contextRailPinned: false,
    preLaunchHook: async (homeRoot) => {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        db.raw.prepare("INSERT OR REPLACE INTO threads(thread_id, payload) VALUES (?, ?)").run(`codex:${source}`, JSON.stringify({
          backend: "codex", threadId: source, executionMode: "default", model: "gpt-5.5", reasoningEffort: "high", extraLinkedDirectories: [],
        }));
        new ThreadTodoService({ store: new ThreadTodoStore(db), now: () => 1_791_600_000_000, newId: () => "atlas-card-1" }).add({
          backend: "codex", threadId: source,
          sourceProject: { key: "directory:atlas", label: "atlas", path: "/example/atlas" },
          input: { title: "Rotate the webhook signing keys",
            detail: "Fetching the new keys from the vault needs network access.",
            action: { type: "start_thread", prompt: "Rotate the webhook signing keys and publish the new key ids.", executionMode: "full-access" },
          },
        });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    await app.window.getByRole("button", { name: "Webhook delivery hardening", exact: true }).click();
    const stack = app.window.getByRole("region", { name: "To-dos for this thread" });
    const start = stack.getByRole("button", { name: "Start thread", exact: true });
    await expect(start).toBeVisible();
    await expect.poll(() => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.listBackends!()).backends.find((backend) => backend.kind === "codex")?.available;
    })).toBe(true);
    const access = accessTrigger(app.window);
    await expect(access).toHaveAttribute("data-value", "default");

    await start.click();
    const warning = app.window.getByRole("dialog", { name: "Enable Full Access?" });
    await expect(warning).toContainText("network access");
    await expect(warning).toContainText("read/write access");
    const [viewportWidth, dialogBox] = await Promise.all([
      app.window.evaluate(() => window.innerWidth),
      warning.boundingBox(),
    ]);
    expect(dialogBox).not.toBeNull();
    expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewportWidth / 2)).toBeLessThan(2);

    // A click outside the modal neither dismisses it nor starts anything.
    await app.window.mouse.click(20, 20);
    await expect(warning).toBeVisible();
    await expect(access).toHaveAttribute("data-value", "default");
    expect(await app.getLastStartTurn()).toBeUndefined();

    await warning.getByRole("button", { name: "I Understand and Accept the Risks" }).click();
    await expect(warning).toBeHidden();
    await expect.poll(() => app.getLastStartTurn()).toMatchObject({
      threadId: started,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
