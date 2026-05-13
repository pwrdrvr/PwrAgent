import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createCodexEnvironmentSetupFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
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
`,
    "utf8",
  );

  const fixturePath = path.join(rootDir, "codex-environment-setup.fixture.json");
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
            result: [
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
    fixturePath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
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

    await app.window.getByRole("button", { name: "Codex environment" }).click();
    await app.window.getByRole("option", { name: "Fixture Env" }).click();
    await expect(app.window.getByLabel("Run setup")).toBeChecked();

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
    await expect(
      app.window
        .locator('[aria-label="Setup output"]')
        .getByText("setup-output", { exact: true }),
    ).toBeVisible();

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
        .getByText("setup-output", { exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
