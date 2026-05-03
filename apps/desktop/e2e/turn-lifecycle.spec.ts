import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const turnLifecycleSpecDir = path.dirname(fileURLToPath(import.meta.url));

async function createActiveTurnThinkingFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-active-turn-thinking-"));
  const fixturePath = path.join(rootDir, "active-turn-thinking.fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "active-turn-thinking",
          threadId: "thread-active-turn-thinking",
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
                id: "thread-active-turn-thinking",
                title: "Active turn thinking replay",
                titleSource: "explicit",
                summary: "Replay seeded active turn thinking state",
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
                  id: "message-1",
                  role: "user",
                  text: "Keep working while I watch the transcript footer.",
                },
                {
                  type: "message",
                  id: "message-2",
                  role: "assistant",
                  text: "Baseline transcript is ready.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: "Keep working while I watch the transcript footer.",
                },
                {
                  id: "message-2",
                  role: "assistant",
                  text: "Baseline transcript is ready.",
                },
              ],
              lastUserMessage: "Keep working while I watch the transcript footer.",
              lastAssistantMessage: "Baseline transcript is ready.",
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
                threadId: "thread-active-turn-thinking",
                turnId: "turn-active-turn-thinking-1",
                turn: {
                  id: "turn-active-turn-thinking-1",
                  status: "inProgress",
                },
              },
            },
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

test("keeps transient turn UI through metadata and premature idle notifications", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      turnLifecycleSpecDir,
      "fixtures/turn-lifecycle/replay.fixture.json"
    )
  });

  try {
    await app.window
      .getByRole("button", { name: /Turn lifecycle replay/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Turn lifecycle replay"
      })
    ).toBeVisible();
    await expect(
      app.window.getByText("lifecycle baseline ready", { exact: true })
    ).toBeVisible();

    await app.window
      .getByLabel("Reply")
      .fill(
        "Create /tmp/pwragent-turn-lifecycle.txt with exactly the text lifecycle second turn."
      );
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "token-usage-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "rate-limits-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "command-output-1" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "status-idle-midturn" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "assistant-delta-1" });
    await app.advance({ stepId: "assistant-delta-2" });

    await expect(
      app.window.getByText(/I'll create the file now\.\s*Verifying the exact bytes next\./)
    ).toBeVisible();

    await app.advance({ stepId: "status-idle-1" });

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(app.window.getByRole("status")).toContainText("Thinking");

    await app.advance({ stepId: "turn-completed-1" });

    await expect(
      app.window.getByRole("button", { name: "Stop" })
    ).toHaveCount(0);
    await expect(
      app.window.getByText("Thinking")
    ).toHaveCount(0);
    const transcript = app.window.getByRole("region", { name: "Transcript" });
    const previousMessagesToggle = transcript.getByRole("button", {
      name: "1 previous message",
    });
    await expect(previousMessagesToggle).toBeVisible();
    await expect(previousMessagesToggle).toHaveAttribute("aria-expanded", "false");
    await expect(
      transcript.getByText(/I'll create the file now\.\s*Verifying the exact bytes next\./)
    ).toBeHidden();
    await expect(
      transcript.getByText(
        "Created /tmp/pwragent-turn-lifecycle.txt with exactly the text lifecycle second turn."
      )
    ).toBeVisible();
    await previousMessagesToggle.click();
    await expect(previousMessagesToggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      transcript.getByText(/I'll create the file now\.\s*Verifying the exact bytes next\./)
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("renders the context window moon from token usage notifications", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      turnLifecycleSpecDir,
      "fixtures/turn-lifecycle/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /Turn lifecycle replay/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Turn lifecycle replay",
      })
    ).toBeVisible();

    await app.window
      .getByLabel("Reply")
      .fill(
        "Create /tmp/pwragent-turn-lifecycle.txt with exactly the text lifecycle second turn."
      );
    await app.window.getByRole("button", { name: "Send" }).click();

    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "token-usage-1" });

    await expect(
      app.window.getByRole("img", {
        name: /Context window 0% full, 1\.2k\/258\.4k tokens, new/,
      })
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("keeps the in-thread thinking indicator visible for active turns without pending text", async () => {
  const fixture = await createActiveTurnThinkingFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });

  try {
    await app.window
      .getByRole("button", { name: /Active turn thinking replay/i })
      .first()
      .click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Active turn thinking replay",
      })
    ).toBeVisible();
    await expect(
      app.window.getByText("Baseline transcript is ready.", { exact: true })
    ).toBeVisible();

    const transcript = app.window.getByRole("region", { name: "Transcript" });
    await expect(transcript.getByRole("status")).toHaveCount(0);

    await app.advance({ stepId: "turn-started-1" });

    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(transcript.getByRole("status")).toContainText("Thinking");
    await expect(
      app.window
        .getByRole("button", { name: /Active turn thinking replay/i })
        .locator('[data-thread-status="thinking"]')
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
