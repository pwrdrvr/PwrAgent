import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";
import { launchElectronApp } from "./fixtures/electron-app";

async function createManagedReviewFixture(): Promise<{
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
            methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
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
        {
          id: "managed-review-child-failed",
          kind: "notification",
          notification: {
            method: "turn/failed",
            params: {
              threadId: "managed-review-child",
              turnId: "managed-review-turn",
              turn: {
                id: "managed-review-turn",
                status: "failed",
                error: { message: "You have 8147 weighted tokens left" },
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

async function launchManagedReviewFixture() {
  const fixture = await createManagedReviewFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    preLaunchHook: (homeRoot) => {
      applyDesktopSettingsPatch(
        path.join(homeRoot, ".pwragent/profiles/default/config.toml"),
        { experimental: { managedReview: true } },
      );
    },
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
    await fixture.app.window.getByLabel("Reply").fill("/review main");
    await fixture.app.window.getByRole("button", { name: "Send" }).click();

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
