import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createCodexEnvironmentSetupFixture(params?: {
  includeExistingRunningSteps?: boolean;
  includeExistingThread?: boolean;
}): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-env-setup-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  await mkdir(path.join(repoDir, ".codex", "environments"), { recursive: true });

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

  await writeFile(
    path.join(repoDir, ".codex", "environments", "environment.toml"),
    `
version = 1
name = "Fixture Env"

[setup]
script = "printf setup-output && sleep 2"

[[actions]]
name = "Capture CWD"
command = "pwd -P > .pwragent-e2e-action-cwd"
`,
    "utf8",
  );

  const fixturePath = path.join(rootDir, "codex-environment-setup.fixture.json");
  const initialThreads =
    params?.includeExistingThread === false
      ? []
      : [
          {
            id: "thread-existing",
            title: "Existing directory thread",
            titleSource: "explicit",
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
        ];
  const existingRunningSteps = params?.includeExistingRunningSteps
    ? [
        {
          id: "existing-thread-status-active",
          kind: "notification" as const,
          notification: {
            method: "thread/status/changed" as const,
            params: {
              threadId: "thread-existing",
              status: {
                type: "active" as const,
                activeFlags: [],
              },
            },
          },
        },
        {
          id: "existing-thread-turn-started",
          kind: "notification" as const,
          notification: {
            method: "turn/started" as const,
            params: {
              threadId: "thread-existing",
              turnId: "turn-existing-1",
              turn: {
                id: "turn-existing-1",
                status: "in_progress" as const,
                startedAt: 1_500,
              },
            },
          },
        },
      ]
    : [];
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "codex-environment-setup",
          threadId: "thread-env",
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
            result: initialThreads,
          },
          {
            id: "thread-read-1",
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
          ...existingRunningSteps,
          {
            id: "thread-start-1",
            kind: "response",
            method: "thread/start",
            result: {
              threadId: "thread-env",
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-env",
              turnId: "turn-env-1",
            },
          },
          {
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            result: [
              ...initialThreads,
              {
                id: "thread-env",
                title: "hello env",
                titleSource: "derived",
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
            ],
          },
          {
            id: "thread-read-2",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "thread-env-message-1",
                  role: "user",
                  text: "hello env",
                },
              ],
              messages: [
                {
                  id: "thread-env-message-1",
                  role: "user",
                  text: "hello env",
                },
              ],
              lastUserMessage: "hello env",
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
    repoDir,
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

function getSecondaryWorktreePath(repoDir: string): string | undefined {
  const output = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  const repoRealPath = realpathSync.native(repoDir);
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .find((worktreePath) => realpathSync.native(worktreePath) !== repoRealPath);
}

async function createNoCodexEnvironmentsFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-no-env-"));
  const repoDir = path.join(rootDir, "NoEnvRepo");
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, ".codex"), "not a directory\n", "utf8");

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
      "Seed no-env fixture repo",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );

  const fixturePath = path.join(rootDir, "codex-no-environments.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "codex-no-environments",
          threadId: "thread-no-env",
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
                id: "thread-no-env",
                title: "No environment thread",
                titleSource: "explicit",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [
                  {
                    id: "no-env-repo",
                    label: "NoEnvRepo",
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
              entries: [],
              messages: [],
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

async function readActionCwdMarker(params: {
  localPath: string;
  worktreePath: string;
}): Promise<string> {
  for (const candidatePath of [params.worktreePath, params.localPath]) {
    try {
      return await readFile(
        path.join(candidatePath, ".pwragent-e2e-action-cwd"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return "";
}

test("selected Codex environments run setup and show transcript output", async () => {
  const fixture = await createCodexEnvironmentSetupFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    await expect(app.window.getByRole("textbox", { name: "New thread" })).toBeVisible();
    const launchpadTools = app.window.getByLabel("Composer tools");
    await launchpadTools.getByRole("button", { name: "Codex environment" }).click();
    await app.window.getByRole("option", { name: "Fixture Env" }).click();
    await expect(
      launchpadTools.locator("label", { hasText: "Run setup" }).locator("input"),
    ).toBeChecked();

    await app.window.getByRole("textbox", { name: "New thread" }).fill("hello env");
    await app.window.getByRole("button", { name: "Start thread" }).click();
    await expect(
      app.window
        .getByRole("region", { name: "Preparing transcript" })
        .getByRole("heading", { name: "Running environment setup" }),
    ).toBeVisible();
    await expect(
      app.window
        .locator('[aria-label="Setup command"]')
        .getByText("$ printf setup-output && sleep 2"),
    ).toBeVisible();
    await expect(app.window.locator('[aria-label="Setup output"]')).toContainText(
      "setup-output",
    );

    await expect(
      app.window.getByRole("heading", { level: 2, name: "hello env" }),
    ).toBeVisible();
    await expect(
      app.window
        .getByRole("region", { name: "Transcript" })
        .getByText("Environment setup completed: Fixture Env"),
    ).toBeVisible();

    await app.window
      .getByRole("button", { name: /Environment setup completed: Fixture Env/ })
      .click();
    await app.window.getByRole("button", { name: /Setup command/ }).click();
    await expect(
      app.window
        .getByRole("region", { name: "Transcript" })
    ).toContainText("setup-output");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("existing running thread keeps selected Codex environment after pending state clears", async () => {
  const fixture = await createCodexEnvironmentSetupFixture({
    includeExistingRunningSteps: true,
  });
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window
      .getByRole("button", { name: /Existing directory thread/ })
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Existing directory thread" }),
    ).toBeVisible();

    await app.advance({ stepId: "existing-thread-status-active" });
    await app.advance({ stepId: "existing-thread-turn-started" });
    await expect(app.window.getByRole("button", { name: "Stop" })).toBeVisible();

    const environmentDropdown = app.window.getByLabel("Codex environment");
    await expect(environmentDropdown).toHaveAttribute("data-value", "");
    await environmentDropdown.click();
    await app.window.getByRole("option", { name: "Fixture Env" }).click();

    await expect(app.window.getByRole("status")).toContainText("Thinking");
    await expect(environmentDropdown).toHaveAttribute("data-value", "environment");
    await expect(environmentDropdown).toContainText("Fixture Env");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("thread environment Run command uses the current cwd after workspace handoff", async () => {
  const fixture = await createCodexEnvironmentSetupFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window
      .getByRole("button", { name: /Existing directory thread/ })
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Existing directory thread" }),
    ).toBeVisible();

    await app.window.getByLabel("Codex environment").click();
    await app.window.getByRole("option", { name: "Fixture Env" }).click();
    await expect(app.window.getByLabel("Codex environment")).toContainText(
      "Fixture Env",
    );
    await expect(app.window.getByLabel("Environment command")).toContainText(
      "Capture CWD",
    );

    await app.window.getByLabel("Workspace mode").click();
    await app.window.getByRole("menuitem", { name: "Handoff to New Worktree" }).click();
    const dialog = app.window.getByRole("dialog", { name: "Handoff to New Worktree" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Handoff" }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => getSecondaryWorktreePath(fixture.repoDir) ?? "", {
        timeout: 5_000,
      })
      .not.toBe("");
    const worktreePath = getSecondaryWorktreePath(fixture.repoDir);
    expect(worktreePath).toBeTruthy();

    await app.window.getByRole("button", { name: "Run" }).click();
    await expect
      .poll(
        async () =>
          await app.window.evaluate(async () => {
            const desktopApi = (window as any).pwragent;
            const snapshot = await desktopApi.getNavigationSnapshot({ backend: "codex" });
            const thread = snapshot.threads.find(
              (candidate: { id: string }) => candidate.id === "thread-existing",
            );
            return thread?.codexEnvironmentRuntime?.actionStatus ?? "missing";
          }),
        { timeout: 5_000 },
      )
      .toBe("started");
    await expect
      .poll(
        async () =>
          await readActionCwdMarker({
            localPath: fixture.repoDir,
            worktreePath: worktreePath!,
          }),
        {
          timeout: 5_000,
        },
      )
      .toBe(`${await realpath(worktreePath!)}\n`);

    await app.window.getByLabel("Workspace mode").click();
    await app.window.getByRole("menuitem", { name: "Handoff to Local" }).click();
    const returnDialog = app.window.getByRole("dialog", { name: "Handoff to Local" });
    await expect(returnDialog).toBeVisible();
    await returnDialog.getByRole("button", { name: "Handoff" }).click();
    await expect(returnDialog).toBeHidden();

    await app.window.getByRole("button", { name: "Run" }).click();
    await expect
      .poll(
        async () =>
          await readFile(
            path.join(fixture.repoDir, ".pwragent-e2e-action-cwd"),
            "utf8",
          ),
        {
          timeout: 5_000,
        },
      )
      .toBe(`${await realpath(fixture.repoDir)}\n`);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad keeps selected Codex environment controls after snapshot reload", async () => {
  const fixture = await createCodexEnvironmentSetupFixture({
    includeExistingThread: false,
  });
  let firstApp: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  let secondApp: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  let seededHomeRoot: string | undefined;

  try {
    const directoryKey = `directory:${fixture.repoDir}`;
    firstApp = await launchElectronApp({
      fixturePath: fixture.fixturePath,
    });
    seededHomeRoot = firstApp.homeRoot;

    await firstApp.window.evaluate(
      async ({ directoryKey, repoDir }) => {
        const desktopApi = (window as any).pwragent;
        await desktopApi.ensureDirectoryLaunchpad({
          directoryKey,
          directoryKind: "directory",
          directoryLabel: "FixtureRepo",
          directoryPath: repoDir,
          preferredBackend: "codex",
          currentBranch: "main",
        });
        await desktopApi.updateDirectoryLaunchpad({
          directoryKey,
          patch: {
            codexEnvironmentId: "environment",
            codexEnvironmentExecutionTarget: "local",
            codexEnvironmentSetupEnabled: true,
            workMode: "worktree",
          },
          stickySettingsChanged: true,
        });
      },
      { directoryKey, repoDir: fixture.repoDir },
    );

    await firstApp.electronApp.close();
    firstApp = undefined;

    secondApp = await launchElectronApp({
      fixturePath: fixture.fixturePath,
      homeRoot: seededHomeRoot,
    });
    seededHomeRoot = undefined;

    const settings = secondApp.window.getByLabel("New thread settings");
    await expect(
      secondApp.window.getByRole("textbox", { name: "New thread" }),
    ).toBeVisible();
    await expect(settings.getByLabel("Workspace mode")).toHaveAttribute(
      "data-value",
      "worktree",
    );
    const tools = secondApp.window.getByLabel("Composer tools");
    await expect(tools.getByLabel("Codex environment")).toContainText(
      "Fixture Env",
    );
    await expect(tools.getByLabel("Run setup")).toBeChecked();
  } finally {
    if (secondApp) {
      await secondApp.close();
    }
    if (firstApp) {
      await firstApp.close();
    }
    if (seededHomeRoot) {
      await rm(seededHomeRoot, { recursive: true, force: true });
    }
    await fixture.cleanup();
  }
});

test("directory launchpad opens without an environment picker when no environments are available", async () => {
  const fixture = await createNoCodexEnvironmentsFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for NoEnvRepo" })
      .click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "NoEnvRepo" }),
    ).toBeVisible();
    await expect(app.window.getByRole("textbox", { name: "New thread" })).toBeVisible();
    await expect(app.window.getByLabel("Codex environment")).toHaveCount(0);
    await expect(
      app.window.getByText(/Error invoking remote method|ENOTDIR/),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
