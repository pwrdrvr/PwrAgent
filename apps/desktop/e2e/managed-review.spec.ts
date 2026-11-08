import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

async function createManagedReviewFixture(interruption = false): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-managed-review-"));
  const fixturePath = path.join(rootDir, "managed-review.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify({
      metadata: {
        backend: "codex",
        scenario: "managed-review-terminal-gating",
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: { name: "Replay Codex", version: "1.0.0" },
            methods: ["thread/list", "thread/read", "skills/list", "thread/start", "turn/start", "turn/interrupt"],
          },
        },
        {
          id: "thread-list-1",
          kind: "response",
          method: "thread/list",
          result: [{
            id: "thread-parent",
            title: "Managed review failure",
            titleSource: "explicit",
            summary: "Managed review terminal gating",
            source: "codex",
            executionMode: "default",
            linkedDirectories: [],
            updatedAt: 2_000,
          }],
        },
        {
          id: "thread-read-1",
          kind: "response",
          method: "thread/read",
          result: {
            entries: [],
            messages: [],
            threadStatus: "idle",
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        },
        {
          // Independent composer reads reuse this answer, including after
          // thread/start and turn/start have consumed the response block.
          id: "skills-list-1",
          kind: "response",
          method: "skills/list",
          result: [],
        },
        {
          id: "managed-review-thread-start",
          kind: "response",
          method: "thread/start",
          result: { threadId: "managed-review-child" },
        },
        {
          id: "managed-review-turn-start",
          kind: "response",
          method: "turn/start",
          result: {
            threadId: "managed-review-child",
            turnId: "managed-review-turn",
          },
        },
        ...(interruption ? [{
          id: "managed-review-interrupt",
          kind: "response",
          method: "turn/interrupt",
          result: { threadId: "managed-review-child", turnId: "managed-review-turn" },
        }] : []),
        {
          id: interruption ? "managed-review-child-cancelled" : "managed-review-child-failed",
          kind: "notification",
          notification: {
            method: interruption ? "turn/cancelled" : "turn/failed",
            params: {
              threadId: "managed-review-child",
              turnId: "managed-review-turn",
              turn: {
                id: "managed-review-turn",
                status: interruption ? "cancelled" : "failed",
                ...(interruption ? {} : { error: { message: "You have 8147 weighted tokens left" } }),
              },
            },
          },
        },
      ],
    }, null, 2),
    "utf8",
  );
  return {
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function launchManagedReviewFixture(interruption = false) {
  const fixture = await createManagedReviewFixture(interruption);
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });
  return {
    app,
    close: async () => {
      await app.close();
      await fixture.cleanup();
    },
  };
}

test("managed review failure leaves one start marker and clears Stop state", async () => {
  const fixture = await launchManagedReviewFixture();
  try {
    await fixture.app.window
      .getByRole("button", { name: /Managed review failure/i })
      .first()
      .click();
    await fixture.app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("/review");
    await fixture.app.window.getByRole("button", { name: "Send" }).click();

    const reviewTarget = fixture.app.window.getByRole("group", { name: "Review target" });
    await reviewTarget.getByRole("combobox", { name: "Base branch" }).fill("main");
    const runMode = reviewTarget.getByRole("button", { name: /^Review run mode(?::|$)/, exact: true });
    await expect(runMode).toBeEnabled();
    await runMode.click();
    const managedMode = reviewTarget.getByRole("option", { name: "PwrAgent Sub Agent", exact: true });
    await expect(managedMode).toBeEnabled();
    await managedMode.click();
    const startReview = reviewTarget.getByRole("button", { name: "Start review" });
    await expect(startReview).toBeEnabled();
    await startReview.click();

    const transcript = fixture.app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByText("Review changes against main")).toHaveCount(1);
    await expect(fixture.app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await expect.poll(async () => await fixture.app.getLastStartTurn()).toMatchObject({
      threadId: "managed-review-child",
      input: [{ type: "text", text: expect.stringContaining("Perform a code review") }],
    });

    await fixture.app.advance({ stepId: "managed-review-child-failed" });

    await expect(
      fixture.app.window.getByTestId("composer-stop-turn"),
    ).toHaveCount(0);
    await expect(transcript).toContainText("Turn failed");
    await expect(transcript).not.toContainText("Code review completed");
    await expect(transcript.getByText("Review changes against main")).toHaveCount(1);
  } finally {
    await fixture.close();
  }
});

test("interrupting a managed review targets its child and keeps the parent active until the child terminal", async () => {
  const fixture = await launchManagedReviewFixture(true);
  try {
    const { app } = fixture;
    await app.window.getByRole("button", { name: /Managed review failure/i }).first().click();
    await app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("/review");
    await app.window.getByRole("button", { name: "Send", exact: true }).click();
    const reviewTarget = app.window.getByRole("group", { name: "Review target" });
    await reviewTarget.getByRole("combobox", { name: "Base branch" }).fill("main");
    await reviewTarget.getByRole("button", { name: /^Review run mode(?::|$)/, exact: true }).click();
    await reviewTarget.getByRole("option", { name: "PwrAgent Sub Agent", exact: true }).click();
    await reviewTarget.getByRole("button", { name: "Start review", exact: true }).click();
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.window.evaluate(() => {
      const observed = window as unknown as { pwragent: DesktopApi; reviewCancellations: unknown[] };
      observed.reviewCancellations = [];
      observed.pwragent.onAgentEvent!((event) => {
        if (event.notification.method === "turn/cancelled" && event.notification.params.threadId === "thread-parent") {
          observed.reviewCancellations.push({ threadId: event.notification.params.threadId,
            turnId: event.notification.params.turnId });
        }
      });
    });
    await app.window.getByTestId("composer-stop-turn").click();
    await expect.poll(() => app.getInterruptTurnCalls()).toEqual([
      { threadId: "managed-review-child", turnId: "managed-review-turn" },
    ]);
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.advance({ stepId: "managed-review-child-cancelled" });
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    expect(await app.window.evaluate(() => (window as unknown as { reviewCancellations: unknown[] }).reviewCancellations))
      .toEqual([{ threadId: "thread-parent", turnId: "managed-review-turn" }]);
  } finally {
    await fixture.close();
  }
});
