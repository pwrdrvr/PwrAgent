import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";

async function createDirectoryLaunchpadTranscriptFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-sync-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  await mkdir(repoDir, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PwrAgent Tests",
      "-c",
      "user.email=pwragent-tests@example.invalid",
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

test("directory launchpad preserves all-pinned placement and rereads an initially empty transcript after completion", async () => {
  const testInfo = test.info();
  const fixture = await createDirectoryLaunchpadTranscriptFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    preLaunchHook: async (homeRoot) => {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
      try {
        await new SqliteOverlayStore(db).setThreadPin({ backend: "codex", threadId: "thread-existing", pinnedRank: "1024" });
      } finally {
        db.close();
      }
    },
  });

  app.electronApp.process().stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) if (line.includes("PIN_DEBUG")) console.log(line);
  });
  try {
    await app.window.getByRole("tab", { name: "directories" }).click();
    await expect(app.window.getByText("Directory threads", { exact: true })).toHaveCount(0);
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
    const directory = app.window.locator(".directory-row").filter({
      has: app.window.getByRole("button", { name: /^FixtureRepo(,|$)/ }),
    });
    // Capture the final state even against the regression, where the new
    // thread appears below a newly created Directory threads disclosure.
    await directory.screenshot({ path: testInfo.outputPath("all-pinned-creation.png") });
    await expect(directory.locator('.thread-row-shell[data-thread-pin-state="pinned"] .thread-row__title'))
      .toHaveText(["hello from launchpad", "Existing directory thread"]);
    await expect(directory.getByText("Directory threads", { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
