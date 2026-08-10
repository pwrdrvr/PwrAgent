import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createThreadRowStatusFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-row-status-"));
  const fixturePath = path.join(rootDir, "thread-row-status.fixture.json");
  const linkedDirectory = {
    id: "thread-row-status-directory",
    label: "Thread row status fixture",
    path: rootDir,
    kind: "local",
  };

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-row-status",
          threadId: "thread-initiated",
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
              methods: ["thread/list", "thread/read", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-initiated",
                title: "Initiated thread",
                titleSource: "explicit",
                summary: "A thread we start from the app",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [linkedDirectory],
                updatedAt: 1_000,
              },
              {
                id: "thread-reference",
                title: "Reference thread",
                titleSource: "explicit",
                summary: "A thread we switch to while the first one runs",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [linkedDirectory],
                updatedAt: 1_500,
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
                  id: "initiated-message-1",
                  role: "assistant",
                  text: "Initiated thread baseline",
                },
              ],
              messages: [
                {
                  id: "initiated-message-1",
                  role: "assistant",
                  text: "Initiated thread baseline",
                },
              ],
              lastAssistantMessage: "Initiated thread baseline",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-initiated",
              turnId: "turn-initiated-1",
            },
          },
          {
            id: "thread-read-2",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "reference-message-1",
                  role: "assistant",
                  text: "Reference thread baseline",
                },
              ],
              messages: [
                {
                  id: "reference-message-1",
                  role: "assistant",
                  text: "Reference thread baseline",
                },
              ],
              lastAssistantMessage: "Reference thread baseline",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "turn-started-1",
            kind: "notification",
            notification: {
              method: "turn/started",
              params: {
                threadId: "thread-initiated",
                turn: {
                  id: "turn-initiated-1",
                  status: "inProgress",
                },
              },
            },
          },
          {
            id: "turn-completed-1",
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread-initiated",
                turnId: "turn-initiated-1",
                turn: {
                  id: "turn-initiated-1",
                  status: "completed",
                  output: [
                    {
                      type: "text",
                      text: "Finished the initiated turn.",
                    },
                  ],
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
                id: "thread-initiated",
                title: "Initiated thread",
                titleSource: "explicit",
                summary: "A thread we start from the app",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [linkedDirectory],
                updatedAt: 2_000,
              },
              {
                id: "thread-reference",
                title: "Reference thread",
                titleSource: "explicit",
                summary: "A thread we switch to while the first one runs",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [linkedDirectory],
                updatedAt: 1_500,
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

test("shows initiated background turns as thinking, then unread once they finish", async () => {
  const fixture = await createThreadRowStatusFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    const browseSection = app.window.locator(".sidebar__section--fill");
    const initiatedRow = browseSection.getByRole("button", {
      name: /Initiated thread/i,
    });

    await initiatedRow.click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Initiated thread",
      })
    ).toBeVisible();

    await app.window.getByLabel("Reply").fill("Keep working on this thread.");
    await app.window.getByRole("button", { name: "Send" }).click();

    await browseSection.getByRole("button", { name: /Reference thread/i }).click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Reference thread",
      })
    ).toBeVisible();

    await expect(initiatedRow.locator('[data-thread-status="thinking"]')).toBeVisible();
    await expect(initiatedRow.locator('[data-thread-status="unread"]')).toHaveCount(0);

    // The aggregate activity signal lives on the Attention tab now, not on
    // Directories — a live turn counts as active, never as to-review.
    await expect(
      app.window.getByRole("tab", {
        name: "Attention, 1 active thread, 0 threads to review",
      }),
    ).toBeVisible();

    await app.window.getByRole("tab", { name: "Directories" }).click();
    // The counts are indicator + number now; the words moved into a hover
    // tooltip, so the stable handle is the data attribute rather than `title`.
    await expect(
      app.window
        .locator(".directory-row__summary")
        .filter({ hasText: "Thread row status fixture" })
        .locator('[data-active-thread-count="1"]'),
    ).toBeVisible();
    await expect(
      app.window
        .locator(".directory-row__summary")
        .filter({ hasText: "Thread row status fixture" })
        .locator("[data-review-thread-count]"),
    ).toHaveCount(0);

    await app.advance({ stepId: "turn-started-1" });
    await expect(initiatedRow.locator('[data-thread-status="thinking"]')).toBeVisible();

    await app.advance({ stepId: "turn-completed-1" });

    await expect(initiatedRow.locator('[data-thread-status="thinking"]')).toHaveCount(0);
    await expect(initiatedRow.locator('[data-thread-status="unread"]')).toBeVisible();
    await expect(initiatedRow.locator(".thread-row__status-cookie")).toBeVisible();
    // Turn finished: the thread leaves the active count and becomes unread, and
    // the Attention tab has to move with it.
    await expect(
      app.window.getByRole("tab", {
        name: "Attention, 0 active threads, 1 thread to review",
      }),
    ).toBeVisible();
    await expect(
      app.window.locator('[data-active-thread-count="1"]'),
    ).toHaveCount(0);
    await expect(
      app.window
        .locator(".directory-row__summary")
        .filter({ hasText: "Thread row status fixture" })
        .locator('[data-review-thread-count="1"]'),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
