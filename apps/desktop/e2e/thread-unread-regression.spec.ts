import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createUnreadRegressionFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-unread-"));
  const fixturePath = path.join(rootDir, "thread-unread-regression.fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-unread-regression",
          threadId: "thread-read",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: {
                name: "Replay Codex",
                version: "1.0.0",
              },
              methods: ["thread/list", "thread/read"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-read",
                title: "Read thread",
                titleSource: "explicit",
                summary: "A thread that has already been read",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                createdAt: 1_000,
                updatedAt: 1_000,
              },
              {
                id: "thread-other",
                title: "Other thread",
                titleSource: "explicit",
                summary: "A separate thread",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                createdAt: 900,
                updatedAt: 900,
              },
            ],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "read-message-1",
                  role: "assistant",
                  text: "There is nothing new to read here.",
                },
              ],
              messages: [
                {
                  id: "read-message-1",
                  role: "assistant",
                  text: "There is nothing new to read here.",
                },
              ],
              lastAssistantMessage: "There is nothing new to read here.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "unrelated-turn-completed",
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread-other",
                turnId: "turn-other-1",
                turn: {
                  id: "turn-other-1",
                  status: "completed",
                  output: [],
                },
              },
            },
          },
          {
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-read",
                title: "Read thread",
                titleSource: "explicit",
                summary: "A thread that has already been read",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                createdAt: 1_000,
                updatedAt: 2_000,
              },
              {
                id: "thread-other",
                title: "Other thread refreshed",
                titleSource: "explicit",
                summary: "A separate thread changed elsewhere",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                createdAt: 900,
                updatedAt: 1_100,
              },
            ],
          },
        ],
      },
      null,
      2
    )
  );

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    fixturePath,
  };
}

test("does not make the selected read thread unread after a metadata-only refresh", async () => {
  const fixture = await createUnreadRegressionFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    const browseSection = app.window.locator(".sidebar__section--fill");
    const readRow = browseSection.getByRole("button", {
      name: /Read thread/i,
    });

    await expect(readRow).toBeVisible();
    await readRow.click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Read thread",
      })
    ).toBeVisible();
    await expect(readRow.locator('[data-thread-status="unread"]')).toHaveCount(0);

    await app.advance({ stepId: "unrelated-turn-completed" });
    await expect(
      browseSection.getByRole("button", { name: /Other thread refreshed/i })
    ).toBeVisible();
    await expect(readRow.locator('[data-thread-status="unread"]')).toHaveCount(0);

    await browseSection
      .getByRole("button", { name: /Other thread refreshed/i })
      .click();
    await expect(readRow.locator('[data-thread-status="unread"]')).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
