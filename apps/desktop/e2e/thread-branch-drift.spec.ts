import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { launchElectronApp } from "./fixtures/electron-app";

async function createBranchDriftFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  homeDir: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-branch-drift-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  // Use the legacy "pwragnt" directory name because the migration code in
  // migration.ts intentionally looks for legacy files at this path.
  const stateRoot = path.join(rootDir, ".local", "state", "pwragnt");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stateRoot, { recursive: true });

  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "codex/expected-branch"], {
    cwd: repoDir,
    stdio: "ignore",
  });
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
      "Seed expected branch",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
  execFileSync("git", ["checkout", "-B", "codex/current-branch"], {
    cwd: repoDir,
    stdio: "ignore",
  });

  await writeFile(
    path.join(stateRoot, "overlay-state.json"),
    JSON.stringify(
      {
        version: 5,
        backends: {},
        launchpadDefaults: {
          backend: "codex",
          executionMode: "default",
          workMode: "local",
        },
        directoryLaunchpads: {},
        threads: {
          "codex:thread-branch-drift": {
            backend: "codex",
            threadId: "thread-branch-drift",
            executionMode: "default",
            observedGitBranch: "codex/expected-branch",
            extraLinkedDirectories: [
              {
                id: "pwragent-handoff:codex:thread-branch-drift",
                kind: "worktree",
                label: "FixtureRepo",
                path: repoDir,
                worktreePath: repoDir,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  const fixturePath = path.join(rootDir, "thread-branch-drift.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-branch-drift",
          threadId: "thread-branch-drift",
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
                id: "thread-branch-drift",
                title: "Branch drift replay",
                titleSource: "explicit",
                summary: "A thread whose checkout changed branch.",
                source: "codex",
                executionMode: "default",
                gitBranch: "codex/expected-branch",
                linkedDirectories: [],
                updatedAt: 1_760_000_000_000,
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
                  role: "assistant",
                  text: "The branch drift replay is loaded.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "assistant",
                  text: "The branch drift replay is loaded.",
                },
              ],
              lastAssistantMessage: "The branch drift replay is loaded.",
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
  );

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    fixturePath,
    homeDir: rootDir,
  };
}

function readThreadPayload(homeDir: string): Record<string, unknown> {
  const dbPath = path.join(
    homeDir,
    ".pwragent",
    "profiles",
    "default",
    "state",
    "state.db",
  );
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT payload FROM threads WHERE thread_id = ?")
      .get("codex:thread-branch-drift") as { payload: string } | undefined;
    expect(row).toBeDefined();
    return JSON.parse(row!.payload) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

test("keeps the branch drift warning open after refreshing observed checkout state", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
  });

  try {
    const dialog = app.window.getByRole("dialog", {
      name: "Thread branch changed",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("codex/expected-branch");
    await expect(dialog).toContainText("codex/current-branch");
    await expect(dialog).toContainText("I'll switch back");
    await expect(dialog).toContainText("Keep current branch");
    await expect(
      app.window.getByRole("button", {
        name: "Keep warning. I'll switch back to codex/expected-branch",
      }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("button", {
        name: "Use current branch. Continue on codex/current-branch",
      }),
    ).toBeVisible();

    await app.window.waitForTimeout(7_000);

    await expect(dialog).toBeVisible();

    expect(readThreadPayload(fixture.homeDir)).toMatchObject({
      gitBranch: "codex/expected-branch",
      observedGitBranch: "codex/current-branch",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("keeps the branch drift indicator when the user keeps the warning", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
  });

  try {
    await app.window
      .getByRole("button", {
        name: "Keep warning. I'll switch back to codex/expected-branch",
      })
      .click();

    await expect(
      app.window.getByRole("dialog", { name: "Thread branch changed" }),
    ).toBeHidden();
    await expect(app.window.getByText(/Branch warning:/)).toBeVisible();
    expect(readThreadPayload(fixture.homeDir)).toMatchObject({
      gitBranch: "codex/expected-branch",
      observedGitBranch: "codex/current-branch",
      retainedBranchDriftPairs: [
        {
          expectedBranch: "codex/expected-branch",
          observedBranch: "codex/current-branch",
        },
      ],
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("updates the expected branch when the user accepts the current branch", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      HOME: fixture.homeDir,
    },
  });

  try {
    await app.window
      .getByRole("button", {
        name: "Use current branch. Continue on codex/current-branch",
      })
      .click();

    await expect(
      app.window.getByRole("dialog", { name: "Thread branch changed" }),
    ).toBeHidden();
    expect(readThreadPayload(fixture.homeDir)).toMatchObject({
      gitBranch: "codex/current-branch",
      observedGitBranch: "codex/current-branch",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
