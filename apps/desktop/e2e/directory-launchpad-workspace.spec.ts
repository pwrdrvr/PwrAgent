import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

async function selectComposerOption(params: {
  option: string | RegExp;
  select: Locator;
  window: Page;
}) {
  await params.select.click();
  await params.window.getByRole("option", { name: params.option }).click();
}

async function createDirectoryLaunchpadFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-launchpad-e2e-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const otherRepoDir = path.join(rootDir, "OtherRepo");
  await mkdir(repoDir, { recursive: true });
  await mkdir(otherRepoDir, { recursive: true });

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
  execFileSync("git", ["branch", "release"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: otherRepoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: otherRepoDir, stdio: "ignore" });
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
      "Seed other fixture repo",
    ],
    { cwd: otherRepoDir, stdio: "ignore" },
  );

  const fixturePath = path.join(rootDir, "directory-launchpad-workspace.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "directory-launchpad-workspace",
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
                gitBranch: "main",
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
              {
                id: "thread-other-directory",
                title: "Other directory replay",
                titleSource: "explicit",
                summary: "Open a new thread from another directory",
                source: "codex",
                executionMode: "default",
                gitBranch: "main",
                linkedDirectories: [
                  {
                    id: "other-repo",
                    label: "OtherRepo",
                    path: otherRepoDir,
                    kind: "local",
                  },
                ],
                updatedAt: 1759999999000,
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
            id: "thread-start-1",
            kind: "response",
            method: "thread/start",
            result: {
              threadId: "thread-new-worktree",
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-new-worktree",
              turnId: "turn-new-worktree-1",
            },
          },
          {
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-new-worktree",
                title: "Use a sticky worktree default",
                titleSource: "derived",
                summary: "Started from the sticky worktree launchpad.",
                source: "codex",
                executionMode: "default",
                gitBranch: "HEAD",
                linkedDirectories: [
                  {
                    id: "fixture-repo",
                    label: "FixtureRepo",
                    path: repoDir,
                    kind: "worktree",
                  },
                ],
                updatedAt: 1760000001000,
              },
              {
                id: "thread-directory-launchpad",
                title: "Directory launchpad replay",
                titleSource: "explicit",
                summary: "Open a new thread from a directory",
                source: "codex",
                executionMode: "default",
                gitBranch: "main",
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
              {
                id: "thread-other-directory",
                title: "Other directory replay",
                titleSource: "explicit",
                summary: "Open a new thread from another directory",
                source: "codex",
                executionMode: "default",
                gitBranch: "main",
                linkedDirectories: [
                  {
                    id: "other-repo",
                    label: "OtherRepo",
                    path: otherRepoDir,
                    kind: "local",
                  },
                ],
                updatedAt: 1759999999000,
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
                  id: "message-new-1",
                  role: "user",
                  text: "Use a sticky worktree default",
                },
              ],
              messages: [
                {
                  id: "message-new-1",
                  role: "user",
                  text: "Use a sticky worktree default",
                },
              ],
              lastUserMessage: "Use a sticky worktree default",
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

test("directory launchpad can switch from local checkout to a new worktree", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
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

    const settings = app.window.getByLabel("New thread settings");
    const workspaceMode = settings.getByLabel("Workspace mode");

    await expect(workspaceMode).toBeEnabled();
    await expect(workspaceMode).toHaveAttribute("data-value", "local");
    await workspaceMode.click();
    await expect(app.window.getByRole("option", { name: "New worktree" })).toHaveCount(1);

    await app.window.getByRole("option", { name: "New worktree" }).click();

    await expect(workspaceMode).toHaveAttribute("data-value", "worktree");
    await expect(settings.getByLabel("Base branch")).toHaveAttribute("data-value", "main");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("opening a directory launchpad without edits does not persist a pending draft", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
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
    const overlay = JSON.parse(
      await readFile(
        path.join(app.homeRoot, ".local", "state", "pwragnt", "overlay-state.json"),
        "utf8",
      ),
    );
    expect(overlay.directoryLaunchpads).toEqual({});
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad keeps full access as the sticky default after user changes access mode", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    const settings = app.window.getByLabel("New thread settings");
    const accessMode = settings.getByLabel("Access mode");
    await expect(accessMode).toHaveAttribute("data-value", "default");
    await selectComposerOption({
      select: accessMode,
      window: app.window,
      option: "Full Access",
    });
    await expect(accessMode).toHaveAttribute("data-value", "full-access");

    await app.window
      .getByRole("button", { name: "Open new thread launchpad for OtherRepo" })
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "OtherRepo" }),
    ).toBeVisible();
    await expect(settings.getByLabel("Access mode")).toHaveAttribute(
      "data-value",
      "full-access",
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad keeps new worktree as the sticky default after starting a thread", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    const settings = app.window.getByLabel("New thread settings");
    const workspaceMode = settings.getByLabel("Workspace mode");

    await selectComposerOption({
      select: workspaceMode,
      window: app.window,
      option: "New worktree",
    });
    await expect(workspaceMode).toHaveAttribute("data-value", "worktree");

    await app.window
      .getByRole("textbox", { name: "New thread" })
      .fill("Use a sticky worktree default");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Use a sticky worktree default",
      }),
    ).toBeVisible();

    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
    ).toBeVisible();

    await expect(settings.getByLabel("Workspace mode")).toHaveAttribute("data-value", "worktree");
    await expect(settings.getByLabel("Base branch")).toHaveAttribute("data-value", "main");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad applies new worktree sticky defaults to stale empty drafts", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();

    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();
    const settings = app.window.getByLabel("New thread settings");
    await expect(settings.getByLabel("Workspace mode")).toHaveAttribute("data-value", "local");

    await app.window
      .getByRole("button", { name: "Open new thread launchpad for OtherRepo" })
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "OtherRepo" }),
    ).toBeVisible();
    const otherWorkspaceMode = settings.getByLabel("Workspace mode");
    await otherWorkspaceMode.click();
    await expect(app.window.getByRole("option", { name: "New worktree" })).toHaveCount(1);
    await app.window.getByRole("option", { name: "New worktree" }).click();
    await expect(otherWorkspaceMode).toHaveAttribute("data-value", "worktree");

    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
    ).toBeVisible();

    await expect(settings.getByLabel("Workspace mode")).toHaveAttribute("data-value", "worktree");
    await expect(settings.getByLabel("Base branch")).toHaveAttribute("data-value", "main");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
