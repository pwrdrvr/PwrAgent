import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createDirectoryLaunchpadTranscriptFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-launchpad-sync-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  await mkdir(repoDir, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PwrAgnt Tests",
      "-c",
      "user.email=pwragnt-tests@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Seed fixture repo",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );

  const fixturePath = path.join(rootDir, "directory-launchpad-transcript-sync.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "directory-launchpad-transcript-sync",
          threadId: "thread-new",
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
                title: "Existing directory thread",
                titleSource: "explicit",
                summary: "Already linked to the repo",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [
                  {
                    id: "fixture-repo",
                    label: "FixtureRepo",
                    path: repoDir,
                    kind: "local",
                  },
                ],
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
                  text: "Existing directory thread",
                },
              ],
              messages: [
                {
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing directory thread",
                },
              ],
              lastAssistantMessage: "Existing directory thread",
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
              threadId: "thread-new",
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-new",
              turnId: "turn-new-1",
            },
          },
          {
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-new",
                title: "hello from launchpad",
                titleSource: "derived",
                summary: "captured after refresh",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [
                  {
                    id: "fixture-repo",
                    label: "FixtureRepo",
                    path: repoDir,
                    kind: "local",
                  },
                ],
                updatedAt: 2_000,
              },
              {
                id: "thread-existing",
                title: "Existing directory thread",
                titleSource: "explicit",
                summary: "Already linked to the repo",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [
                  {
                    id: "fixture-repo",
                    label: "FixtureRepo",
                    path: repoDir,
                    kind: "local",
                  },
                ],
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
                threadId: "thread-new",
                turn: {
                  id: "turn-new-1",
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
                threadId: "thread-new",
                turnId: "turn-new-1",
                turn: {
                  id: "turn-new-1",
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
                  id: "thread-new-message-1",
                  role: "user",
                  text: "hello from launchpad",
                },
                {
                  type: "message",
                  id: "thread-new-message-2",
                  role: "assistant",
                  text: "captured after refresh",
                },
              ],
              messages: [
                {
                  id: "thread-new-message-1",
                  role: "user",
                  text: "hello from launchpad",
                },
                {
                  id: "thread-new-message-2",
                  role: "assistant",
                  text: "captured after refresh",
                },
              ],
              lastUserMessage: "hello from launchpad",
              lastAssistantMessage: "captured after refresh",
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

test("directory launchpad rereads the created thread after completion when the first transcript read was empty", async () => {
  const fixture = await createDirectoryLaunchpadTranscriptFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    await app.window
      .getByRole("textbox", { name: "New thread" })
      .fill("hello from launchpad");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "hello from launchpad" }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("hello from launchpad"),
    ).toBeVisible();
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("No thread history yet."),
    ).toBeHidden();

    await app.advance({ stepId: "turn-started-1" });
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("hello from launchpad"),
    ).toBeVisible();
    await app.advance({ stepId: "turn-completed-1" });

    await expect(
      app.window.getByRole("heading", { level: 2, name: "hello from launchpad" }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("hello from launchpad"),
    ).toBeVisible();
    await expect(
      app.window
        .getByRole("region", { name: "Transcript" })
        .getByText("captured after refresh"),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
