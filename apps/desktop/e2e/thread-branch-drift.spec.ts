import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createBranchDriftFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  stateRoot: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-branch-drift-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const stateRoot = path.join(rootDir, "state");
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
      "user.name=PwrAgnt Tests",
      "-c",
      "user.email=pwragnt-tests@example.invalid",
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
                id: "pwragnt-handoff:codex:thread-branch-drift",
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
    stateRoot,
  };
}

test("keeps the branch drift warning open after refreshing observed checkout state", async () => {
  const fixture = await createBranchDriftFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {
      PWRAGNT_STATE_ROOT: fixture.stateRoot,
    },
  });

  try {
    const dialog = app.window.getByRole("dialog", {
      name: "Thread branch changed",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("codex/expected-branch");
    await expect(dialog).toContainText("codex/current-branch");

    await app.window.waitForTimeout(7_000);

    await expect(dialog).toBeVisible();

    const overlay = JSON.parse(
      await readFile(path.join(fixture.stateRoot, "overlay-state.json"), "utf8"),
    ) as {
      threads: Record<string, { gitBranch?: string; observedGitBranch?: string }>;
    };
    expect(overlay.threads["codex:thread-branch-drift"]).toMatchObject({
      gitBranch: "codex/expected-branch",
      observedGitBranch: "codex/current-branch",
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
