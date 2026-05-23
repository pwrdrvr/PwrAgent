import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createQueuedReviewReleaseFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-queued-review-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const fixturePath = path.join(rootDir, "queued-review-release.fixture.json");
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

  const linkedDirectories = [
    {
      id: "fixture-repo",
      label: "FixtureRepo",
      path: repoDir,
      kind: "local",
    },
  ];
  const replay = {
    entries: [],
    messages: [],
    pagination: {
      supportsPagination: false,
      hasPreviousPage: false,
    },
  };

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "queued-review-release",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: [
                "thread/list",
                "thread/read",
                "turn/start",
                "review/start",
              ],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-active",
                title: "Active branch-changing turn",
                titleSource: "explicit",
                summary: "Queue a review here, then leave the thread",
                source: "codex",
                executionMode: "default",
                gitBranch: "main",
                linkedDirectories,
                updatedAt: 2_000,
              },
              {
                id: "thread-focused",
                title: "Focused holding thread",
                titleSource: "explicit",
                summary: "Stay here while the active turn completes",
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
            result: replay,
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-active",
              turnId: "turn-active",
            },
          },
          {
            id: "turn-started-1",
            kind: "notification",
            notification: {
              method: "turn/started",
              params: {
                threadId: "thread-active",
                turnId: "turn-active",
                turn: {
                  id: "turn-active",
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
                threadId: "thread-active",
                turnId: "turn-active",
                turn: {
                  id: "turn-active",
                  status: "completed",
                  output: [],
                },
              },
            },
          },
          {
            id: "review-start-1",
            kind: "response",
            method: "review/start",
            result: {
              threadId: "thread-active",
              reviewThreadId: "thread-active",
              turnId: "turn-review",
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
    repoDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function createDuplicateTurnStartGuardFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-duplicate-turn-"));
  const fixturePath = path.join(rootDir, "duplicate-turn-start.fixture.json");
  const replay = {
    entries: [],
    messages: [],
    pagination: {
      supportsPagination: false,
      hasPreviousPage: false,
    },
  };

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "duplicate-turn-start-guard",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-active",
                title: "Active duplicate guard",
                titleSource: "explicit",
                summary: "Reject duplicate startTurn calls",
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
            result: replay,
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-active",
              turnId: "turn-active",
            },
          },
          {
            id: "turn-start-duplicate",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-active",
              turnId: "turn-duplicate",
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

test("background queued review releases after active turn branch adoption", async () => {
  const fixture = await createQueuedReviewReleaseFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: { width: 1280, height: 820 },
  });

  try {
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Active branch-changing turn",
      }),
    ).toBeVisible();

    await app.window.getByRole("textbox", { name: "Reply" }).fill("Make a PR");
    await app.window.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({
        threadId: "thread-active",
        input: [{ type: "text", text: "Make a PR" }],
      });

    await app.advance({ stepId: "turn-started-1" });

    await app.window.getByRole("textbox", { name: "Reply" }).fill("/review main");
    await app.window.getByRole("button", { name: "Queue" }).click();
    await expect(app.window.getByLabel("Queued message")).toContainText(
      "Review changes against main",
    );

    await app.window
      .getByRole("button", { name: /Focused holding thread/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Focused holding thread",
      }),
    ).toBeVisible();

    execFileSync("git", ["checkout", "-B", "fix/queued-review-release"], {
      cwd: fixture.repoDir,
      stdio: "ignore",
    });
    await app.advance({ stepId: "turn-completed-1" });

    await expect
      .poll(async () => await app.getLastStartReview())
      .toMatchObject({
        threadId: "thread-active",
        target: {
          type: "baseBranch",
          branch: "main",
        },
        delivery: "inline",
      });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("duplicate Codex turn starts queue through the desktop API while the thread is active", async () => {
  const fixture = await createDuplicateTurnStartGuardFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: { width: 1100, height: 760 },
  });

  try {
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Active duplicate guard",
      }),
    ).toBeVisible();

    const first = await app.window.evaluate(async () => {
      const api = (window as unknown as {
        pwragent: {
          startTurn: (request: {
            backend: "codex";
            executionMode: "default";
            input: Array<{ type: "text"; text: string }>;
            threadId: string;
          }) => Promise<unknown>;
        };
      }).pwragent;
      return await api.startTurn({
        backend: "codex",
        threadId: "thread-active",
        input: [{ type: "text", text: "First queued release" }],
        executionMode: "default",
      });
    });
    expect(first).toMatchObject({
      backend: "codex",
      threadId: "thread-active",
      turnId: "turn-active",
    });

    const second = await app.window.evaluate(async () => {
      const api = (window as unknown as {
        pwragent: {
          startTurn: (request: {
            backend: "codex";
            executionMode: "default";
            input: Array<{ type: "text"; text: string }>;
            threadId: string;
          }) => Promise<unknown>;
        };
      }).pwragent;
      try {
        const response = await api.startTurn({
          backend: "codex",
          threadId: "thread-active",
          input: [{ type: "text", text: "First queued release" }],
          executionMode: "default",
        });
        return { ok: true, response };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
    expect(second).toMatchObject({
      ok: true,
      response: {
        backend: "codex",
        threadId: "thread-active",
        queueStatus: "queued",
        queueEntryId: expect.any(String),
      },
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
