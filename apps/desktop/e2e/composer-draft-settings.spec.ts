import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createComposerDraftSettingsFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-composer-draft-settings-"));
  const fixturePath = path.join(rootDir, "composer-draft-settings.fixture.json");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "composer-draft-settings",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-first",
                title: "Draft survives settings thread",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 2_000,
              },
              {
                id: "thread-second",
                title: "Second draft parking thread",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-read-first",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "first-message-1",
                  role: "assistant",
                  text: "First thread is ready.",
                },
              ],
              messages: [
                {
                  id: "first-message-1",
                  role: "assistant",
                  text: "First thread is ready.",
                },
              ],
              lastAssistantMessage: "First thread is ready.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-read-second",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "second-message-1",
                  role: "assistant",
                  text: "Second thread is ready.",
                },
              ],
              messages: [
                {
                  id: "second-message-1",
                  role: "assistant",
                  text: "Second thread is ready.",
                },
              ],
              lastAssistantMessage: "Second thread is ready.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-read-first-again",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "first-message-1",
                  role: "assistant",
                  text: "First thread is ready.",
                },
              ],
              messages: [
                {
                  id: "first-message-1",
                  role: "assistant",
                  text: "First thread is ready.",
                },
              ],
              lastAssistantMessage: "First thread is ready.",
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

test("keeps a thread reply draft after opening settings and returning to the thread", async () => {
  const fixture = await createComposerDraftSettingsFixture();
  const app = await launchElectronApp({
    env: {
      PWRAGENT_EXPERIMENTAL_CHAT_REPLY_COMPOSER: "tiptap-chips",
    },
    fixturePath: fixture.fixturePath,
  });

  try {
    const draft = "$ce:plan keep this draft through settings";
    const reply = app.window.getByRole("textbox", { name: "Reply" });
    const replyValue = app.window.getByTestId("composer-tiptap-input");

    await app.window
      .getByRole("button", { name: /Draft survives settings thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Draft survives settings thread",
      }),
    ).toBeVisible();

    await reply.fill(draft);

    await app.window
      .getByRole("button", { name: /Second draft parking thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Second draft parking thread",
      }),
    ).toBeVisible();

    await app.window
      .getByRole("button", { name: /Draft survives settings thread/i })
      .first()
      .click();
    await expect(replyValue).toHaveAttribute("data-value", draft);

    await app.window.getByRole("button", { name: "Open settings" }).click();
    await expect(
      app.window.getByRole("heading", {
        level: 1,
        name: "Settings",
      }),
    ).toBeVisible();

    const threadButtonCoveredBySettings = await app.window
      .getByRole("button", { name: /Draft survives settings thread/i })
      .first()
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return Boolean(topElement?.closest(".app-shell__settings-layer"));
      });
    expect(threadButtonCoveredBySettings).toBe(true);

    await app.window.getByRole("button", { name: /Exit Settings/i }).click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Draft survives settings thread",
      }),
    ).toBeVisible();
    await expect(replyValue).toHaveAttribute("data-value", draft);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
