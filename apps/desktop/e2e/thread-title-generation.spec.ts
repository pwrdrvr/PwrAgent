import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const PROMPT =
  "Run `npm view dive` - You'll need to ask to leave the network sandbox";

async function createThreadTitleGenerationFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-thread-title-"));
  const fixturePath = path.join(rootDir, "thread-title-generation.fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-title-generation",
          threadId: "thread-title",
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
              methods: ["thread/list", "thread/read", "turn/start", "thread/name/set"],
            },
          },
          {
            id: "thread-list-initial",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-title",
                title: PROMPT,
                titleSource: "explicit",
                summary: "A thread still using its prompt as the title",
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
                  id: "thread-title-user-1",
                  role: "user",
                  text: PROMPT,
                },
              ],
              messages: [
                {
                  id: "thread-title-user-1",
                  role: "user",
                  text: PROMPT,
                },
              ],
              lastUserMessage: PROMPT,
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
              threadId: "thread-title",
              turnId: "turn-title-1",
            },
          },
          {
            id: "thread-list-title-current",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-title",
                title: PROMPT,
                titleSource: "explicit",
                summary: "A thread still using its prompt as the title",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-list-title-latest-empty",
            kind: "response",
            method: "thread/list",
            result: [],
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

test("applies a generated title even when the latest title lookup has not caught up", async () => {
  const fixture = await createThreadTitleGenerationFixture();
  const app = await launchElectronApp({
    env: {
      PWRAGNT_REPLAY_THREAD_TITLE: "Dive package lookup",
    },
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: new RegExp(PROMPT) }).click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: PROMPT,
      })
    ).toBeVisible();

    await app.window.getByLabel("Reply").fill(PROMPT);
    await app.window.getByRole("button", { name: "Send" }).click();

    await expect
      .poll(async () => await app.getLastRenameThread())
      .toEqual({
        threadId: "thread-title",
        name: "Dive package lookup",
      });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
