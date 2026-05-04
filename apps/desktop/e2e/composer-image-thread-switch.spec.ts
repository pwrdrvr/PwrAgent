import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createComposerImageThreadSwitchFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-composer-image-switch-"));
  const fixturePath = path.join(rootDir, "composer-image-thread-switch.fixture.json");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "composer-image-thread-switch",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "skills/list", "thread/start", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-existing",
                title: "Existing companion thread",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1_000,
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
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing companion thread is ready.",
                },
              ],
              messages: [
                {
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing companion thread is ready.",
                },
              ],
              lastAssistantMessage: "Existing companion thread is ready.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-start-1",
            kind: "response",
            method: "thread/start",
            result: {
              threadId: "thread-created",
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-created",
              turnId: "turn-created-1",
            },
          },
          {
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-created",
                title: "Thread composer regression",
                titleSource: "derived",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 2_000,
              },
              {
                id: "thread-existing",
                title: "Existing companion thread",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-read-2",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [],
              messages: [],
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
                threadId: "thread-created",
                turn: {
                  id: "turn-created-1",
                  status: "inProgress",
                },
              },
            },
          },
          {
            id: "assistant-message-1",
            kind: "notification",
            notification: {
              method: "item/agentMessage/delta",
              params: {
                delta: "First replay response is streaming. ",
                itemId: "assistant-created-1",
                threadId: "thread-created",
                turnId: "turn-created-1",
              },
            },
          },
          {
            id: "assistant-message-2",
            kind: "notification",
            notification: {
              method: "item/agentMessage/delta",
              params: {
                delta: "Second response completed.",
                itemId: "assistant-created-1",
                threadId: "thread-created",
                turnId: "turn-created-1",
              },
            },
          },
          {
            id: "turn-completed-1",
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread-created",
                turnId: "turn-created-1",
                turn: {
                  id: "turn-created-1",
                  status: "completed",
                  output: [],
                },
              },
            },
          },
          {
            id: "thread-read-3",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "thread-created-message-1",
                  role: "user",
                  text: "Start the regression thread",
                },
                {
                  type: "message",
                  id: "thread-created-message-2",
                  role: "assistant",
                  text: "First replay response is streaming. Second response completed.",
                },
              ],
              messages: [
                {
                  id: "thread-created-message-1",
                  role: "user",
                  text: "Start the regression thread",
                },
                {
                  id: "thread-created-message-2",
                  role: "assistant",
                  text: "First replay response is streaming. Second response completed.",
                },
              ],
              lastUserMessage: "Start the regression thread",
              lastAssistantMessage: "First replay response is streaming. Second response completed.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function pasteDelayedImage(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const textarea = document.querySelector<HTMLTextAreaElement>("#thread-composer");
    if (!textarea) {
      throw new Error("Reply textarea not found");
    }

    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function delayedToBlob(callback, type, quality) {
      window.setTimeout(() => {
        originalToBlob.call(this, callback, type, quality);
      }, 500);
    };

    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas context not available");
    }
    context.fillStyle = "#245b55";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f8fafc";
    context.font = "96px sans-serif";
    context.fillText("switch race", 96, 180);

    const blob = await new Promise<Blob>((resolve, reject) => {
      originalToBlob.call(
        canvas,
        (value) => {
          if (!value) {
            reject(new Error("Could not create PNG blob"));
            return;
          }
          resolve(value);
        },
        "image/png",
      );
    });
    const file = new File([blob], "switch-race.png", { type: "image/png" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    textarea.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  });
}

test("keeps a pasted composer image after switching away from a newly created thread", async () => {
  const fixture = await createComposerImageThreadSwitchFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Existing companion thread",
      }),
    ).toBeVisible();

    await app.window.getByRole("button", { name: "New thread" }).click();
    await app.window
      .getByRole("textbox", { name: "New thread" })
      .fill("Start the regression thread");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Thread composer regression",
      }),
    ).toBeVisible();
    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "assistant-message-1" });
    await app.advance({ stepId: "assistant-message-2" });
    await expect(transcript).toContainText("Second response completed.");
    await app.advance({ stepId: "turn-completed-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toHaveCount(0);

    await pasteDelayedImage(app.window);
    await app.window
      .getByRole("button", { name: /Existing companion thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Existing companion thread",
      }),
    ).toBeVisible();
    await app.window
      .getByRole("button", { name: /Thread composer regression/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Thread composer regression",
      }),
    ).toBeVisible();

    await app.window.waitForTimeout(700);
    await expect(app.window.getByLabel("Pasted images")).toHaveCount(1);
    await expect(app.window.getByAltText("switch-race.png")).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
