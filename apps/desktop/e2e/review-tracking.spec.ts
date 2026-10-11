import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

/** Entirely invented data; the artifacts are safe to attach to a PR. */
test("tracks an older review, retains dismissals, and clears To-dos after every finding is settled", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-review-tracking-"));
  const fixturePath = path.join(root, "replay.fixture.json");
  const identity = { backend: "codex" as const, threadId: "thread-review-showcase" };
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "review-tracking", threadId: identity.threadId },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read", "skills/list"],
      } },
      { id: "thread-list", kind: "response", method: "thread/list", result: [{
        id: identity.threadId, title: "Review the Atlas export queue", titleSource: "explicit",
        summary: "Review tracking showcase", source: "codex", executionMode: "default", linkedDirectories: [],
        inbox: { inInbox: true, reason: "new-thread" }, updatedAt: 1_791_600_000_000,
      }] },
      { id: "thread-read", kind: "response", method: "thread/read", result: {
        entries: [{
          type: "review", id: "atlas-review", review: "The export queue needs two corrections.", createdAt: 1_791_600_000_000,
          output: {
            overall_correctness: "patch is incorrect", overall_explanation: "The export queue needs two corrections.",
            findings: [
              { title: "Cancel pending exports when the panel closes", body: "The queue continues after its owner closes. Abort the pending export before releasing the panel.", priority: 1, confidence_score: 0.95,
                code_location: { absolute_file_path: "/example/atlas/src/export-queue.ts", line_range: { start: 42, end: 46 } } },
              { title: "Keep the selected output format", body: "The queue resets the selected format while scheduling a second export. Preserve it until the user changes it.", priority: 2, confidence_score: 0.9,
                code_location: { absolute_file_path: "/example/atlas/src/export-queue.ts", line_range: { start: 81, end: 84 } } },
            ],
          },
          turn: { id: "atlas-review-turn", status: "completed" },
        }], messages: [], threadStatus: "idle", pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      { id: "skills", kind: "response", method: "skills/list", result: { data: [] } },
    ],
  }));
  const app = await launchElectronApp({ fixturePath, contextRailPinned: false });
  try {
    await app.window.getByRole("button", { name: /Review the Atlas export queue/ }).first().click();
    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const card = transcript.getByRole("group", { name: "Code review" });
    await expect(card.getByRole("button", { name: /^Dismiss finding:/ })).toHaveCount(2);
    await app.window.getByRole("region", { name: "To-dos for this thread" })
      .getByRole("button", { name: "Collapse to-dos", exact: true }).click();
    const readReviews = () => app.window.evaluate(async (identity) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.listThreadReviews!({ ...identity, status: "all" })).reviews;
    }, identity);
    await expect.poll(async () => (await readReviews())[0]?.status).toBe("open");
    await app.window.screenshot({ path: testInfo.outputPath("review-waiting.png") });

    await card.getByRole("button", { name: "Dismiss review", exact: true }).click();
    await expect.poll(async () => (await readReviews())[0]?.status).toBe("dismissed");
    await expect(card.getByText("Do not address", { exact: true })).toHaveCount(3);
    await expect(card).toContainText("Cancel pending exports when the panel closes");
    await app.window.screenshot({ path: testInfo.outputPath("review-dismissed.png") });
    await card.getByRole("button", { name: "Reopen review", exact: true }).click();
    await card.getByRole("button", { name: "Mark addressed: Cancel pending exports when the panel closes", exact: true }).click();
    await card.getByRole("button", { name: "Dismiss finding: Keep the selected output format", exact: true }).click();
    await expect.poll(async () => (await readReviews())[0]?.status).toBe("handled");
    const todos = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return (await api.listThreadTodos!()).todos;
    });
    expect(todos.filter((todo) => todo.reviewId)).toEqual([]);
    await expect(card).toContainText("All findings addressed or dismissed.");
    await app.window.screenshot({ path: testInfo.outputPath("review-handled.png") });

    // A renderer reload reads the same artifact again; it must retain outcomes.
    await app.window.reload();
    await expect.poll(async () => (await readReviews())[0]?.status).toBe("handled");
    const stored = (await readReviews())[0]!;
    expect(stored.items.map((item) => item.status)).toEqual(["addressed", "dismissed"]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
