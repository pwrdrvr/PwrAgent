import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createDirectoryLaunchpadSkillsFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-launchpad-skills-"));
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

  const fixturePath = path.join(rootDir, "directory-launchpad-skills.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "directory-launchpad-skills",
          threadId: "thread-directory-launchpad",
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
              methods: ["thread/list", "thread/read", "skills/list", "thread/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-directory-launchpad",
                title: "Directory launchpad replay",
                titleSource: "explicit",
                summary: "Open a new thread from a directory",
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
                updatedAt: 1760000000000,
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
                  text: "Seed the directory launchpad.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: "Seed the directory launchpad.",
                },
              ],
              lastUserMessage: "Seed the directory launchpad.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "skills-list-1",
            kind: "response",
            method: "skills/list",
            result: [
              {
                cwd: repoDir,
                skills: [
                  {
                    name: "frontend-design",
                    description: "Design and verify renderer UI work.",
                    path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
                    enabled: true,
                    scope: "user",
                  },
                  {
                    name: "desktop-e2e-fixture-seeding",
                    description: "Replay-backed desktop E2E fixtures.",
                    path: path.join(
                      repoDir,
                      ".agents/skills/desktop-e2e-fixture-seeding/SKILL.md",
                    ),
                    enabled: true,
                    scope: "local",
                  },
                ],
              },
            ],
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

test("directory launchpad loads skill autocomplete from user and local scope", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
    ).toBeVisible();

    await app.window.getByRole("textbox", { name: "New thread" }).fill("$");

    await expect(
      app.window.getByRole("button", { name: /\$frontend-design/i }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("button", { name: /\$desktop-e2e-fixture-seeding/i }),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
