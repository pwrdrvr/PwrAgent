import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
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
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-e2e-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const otherRepoDir = path.join(rootDir, "OtherRepo");
  const worktreeDir = path.join(rootDir, ".pwragent", "worktrees", "mord46hf", "FixtureRepo");
  await mkdir(repoDir, { recursive: true });
  await mkdir(otherRepoDir, { recursive: true });

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
  execFileSync("git", ["branch", "release"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: otherRepoDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: otherRepoDir, stdio: "ignore" });
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
                    id: repoDir,
                    label: "FixtureRepo",
                    path: repoDir,
                    worktreePath: worktreeDir,
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

async function createLocalHandoffSessionFixture(): Promise<{
  cleanup: () => Promise<void>;
  codexHome: string;
  fixturePath: string;
  repoDir: string;
  sessionPath: string;
  threadId: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-e2e-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const codexHome = path.join(rootDir, ".codex");
  const threadId = "thread-local-handoff";
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
      "Seed handoff fixture repo",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );

  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "04");
  const sessionPath = path.join(
    sessionDir,
    `rollout-2026-05-04T13-22-52-${threadId}.jsonl`,
  );
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      timestamp: "2026-05-04T17:22:52.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd: repoDir,
        originator: "pwragent-desktop",
      },
    })}\n`,
    "utf8",
  );

  const fixturePath = path.join(rootDir, "local-handoff-session.fixture.json");
  const thread = {
    id: threadId,
    title: "Local handoff thread",
    titleSource: "explicit",
    summary: "Move this local thread into a worktree",
    source: "codex",
    executionMode: "default",
    gitBranch: "main",
    observedGitBranch: "main",
    linkedDirectories: [
      {
        id: "fixture-repo",
        label: "FixtureRepo",
        path: repoDir,
        kind: "local",
      },
    ],
    updatedAt: 1760000000000,
  };
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "local-handoff-session-cwd",
          threadId,
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
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [thread],
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
                  text: "Keep this thread visible after handoff.",
                },
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: "Keep this thread visible after handoff.",
                },
              ],
              lastUserMessage: "Keep this thread visible after handoff.",
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
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
    codexHome,
    fixturePath,
    repoDir,
    sessionPath,
    threadId,
  };
}

function readOverlayState(homeRoot: string): {
  directoryLaunchpads: Record<string, unknown>;
} {
  const dbPath = path.join(
    homeRoot,
    ".pwragent",
    "profiles",
    "default",
    "state",
    "state.db",
  );
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT directory_path, payload FROM directory_launchpads")
      .all() as Array<{ directory_path: string; payload: string }>;
    const directoryLaunchpads: Record<string, unknown> = {};
    for (const row of rows) {
      directoryLaunchpads[row.directory_path] = JSON.parse(row.payload);
    }
    return { directoryLaunchpads };
  } finally {
    db.close();
  }
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

test("opening a directory launchpad persists directory identity for future draft saves", async () => {
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

    const rootDir = path.dirname(fixture.fixturePath);
    const repoDir = path.join(rootDir, "FixtureRepo");
    const directoryKey = `directory:${repoDir}`;
    await expect
      .poll(async () => {
        const overlay = await readOverlayState(app.homeRoot);
        return overlay.directoryLaunchpads?.[directoryKey];
      })
      .toMatchObject({
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        prompt: "",
      });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad draft save does not leak the directory key into project labels", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    const rootDir = path.dirname(fixture.fixturePath);
    const repoDir = path.join(rootDir, "FixtureRepo");
    const directoryKey = `directory:${repoDir}`;

    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
    ).toBeVisible();

    await app.window
      .getByRole("textbox", { name: "New thread" })
      .fill("Keep the project identity stable");

    await expect
      .poll(async () => {
        const overlay = await readOverlayState(app.homeRoot);
        return overlay.directoryLaunchpads?.[directoryKey];
      })
      .toMatchObject({
        directoryKey,
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        prompt: "Keep the project identity stable",
      });

    await expect(
      app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
    ).toBeVisible();
    await expect(app.window.getByText(/^directory:/)).toHaveCount(0);
    await expect(app.window.getByText("FixtureRepo").first()).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad repairs stale drafts that saved the internal directory key as the label", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    const rootDir = path.dirname(fixture.fixturePath);
    const repoDir = path.join(rootDir, "FixtureRepo");
    const directoryKey = `directory:${repoDir}`;

    await app.window.evaluate(async (key) => {
      await (window as any).pwragent.updateDirectoryLaunchpad({
        directoryKey: key,
        patch: {
          prompt: "A stale draft that already has content",
        },
      });
    }, directoryKey);

    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
    ).toBeVisible();
    await expect(app.window.getByText(/^directory:/)).toHaveCount(0);

    await expect
      .poll(async () => {
        const overlay = await readOverlayState(app.homeRoot);
        return overlay.directoryLaunchpads?.[directoryKey];
      })
      .toMatchObject({
        directoryKey,
        directoryKind: "directory",
        directoryLabel: "FixtureRepo",
        directoryPath: repoDir,
        prompt: "A stale draft that already has content",
      });
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
    const startTurn = (await app.getLastStartTurn()) as { cwd?: string } | undefined;
    expect(startTurn?.cwd).toContain(`${path.sep}.codex${path.sep}worktrees${path.sep}`);
    const ownerFile = execFileSync(
      "git",
      ["-C", startTurn!.cwd!, "rev-parse", "--git-path", "codex-thread.json"],
      { encoding: "utf8" },
    ).trim();
    await expect(readFile(ownerFile, "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      ownerThreadId: "thread-new-worktree",
    });

    const startedThreadRow = app.window
      .getByRole("button", { name: /Use a sticky worktree default/ })
      .first();
    // Renamed in the chip-flow refactor: meta + PR + binding + reactions
    // chips all share a single `.thread-row__chips` flex-wrap container.
    const startedThreadChips = startedThreadRow.locator(".thread-row__chips");
    await expect(startedThreadChips.getByText("worktree", { exact: true })).toBeVisible();
    await expect(startedThreadChips.getByText("local", { exact: true })).toHaveCount(0);

    const contextRail = app.window.getByRole("complementary", {
      name: "Thread context",
    });
    await contextRail.hover();
    await expect(
      contextRail.getByLabel("Path for worktree FixtureRepo", { exact: true }),
    ).toBeVisible();
    await expect(
      contextRail.getByLabel("Path for local FixtureRepo", { exact: true }),
    ).toHaveCount(0);

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

test("local-to-worktree handoff updates Codex session cwd metadata", async () => {
  const fixture = await createLocalHandoffSessionFixture();
  const app = await launchElectronApp({
    env: {
      CODEX_HOME: fixture.codexHome,
    },
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window
      .getByRole("button", { name: "Local handoff thread" })
      .click();

    const workspaceMode = app.window.getByLabel("Workspace mode");
    await workspaceMode.click();
    await app.window
      .getByRole("menuitem", { name: "Handoff to New Worktree" })
      .click();

    const dialog = app.window.getByRole("dialog", { name: "Handoff to New Worktree" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("radio", { name: /Handoff to Detached HEAD/ }),
    ).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Handoff" }).click();

    await expect
      .poll(async () => {
        const firstLine = (await readFile(fixture.sessionPath, "utf8")).split("\n")[0]!;
        return JSON.parse(firstLine).payload.cwd as string;
      })
      .toContain(`${path.sep}.codex${path.sep}worktrees${path.sep}`);

    const firstLine = (await readFile(fixture.sessionPath, "utf8")).split("\n")[0]!;
    const cwd = JSON.parse(firstLine).payload.cwd as string;
    expect(cwd).not.toBe(fixture.repoDir);

    const ownerFile = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--git-path", "codex-thread.json"],
      { encoding: "utf8" },
    ).trim();
    await expect(readFile(ownerFile, "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      ownerThreadId: fixture.threadId,
    });
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad does not duplicate a materialized worktree thread under path-shaped directory rows", async () => {
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
    await selectComposerOption({
      select: settings.getByLabel("Workspace mode"),
      window: app.window,
      option: "New worktree",
    });

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

    await app.window.getByRole("button", { name: "directories" }).click();
    await expect(app.window.locator(".directory-row").filter({
      has: app.window.getByText("FixtureRepo", { exact: true }),
    })).toHaveCount(1);
    await expect(
      app.window.getByRole("button", { name: /Use a sticky worktree default/ }),
    ).toHaveCount(1);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad keeps Tiptap Markdown focus and fenced-code formatting after changing workspace mode", async () => {
  const fixture = await createDirectoryLaunchpadFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await app.window.getByRole("button", { name: "directories" }).click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.click();
    await app.window.keyboard.type("```ts ");
    await app.window.keyboard.type("const answer = 42;");

    const composer = app.window.getByTestId("composer-tiptap-input");
    await expect(composer.locator("pre")).toBeVisible();

    const settings = app.window.getByLabel("New thread settings");
    await selectComposerOption({
      select: settings.getByLabel("Workspace mode"),
      window: app.window,
      option: "New worktree",
    });

    await expect(composer.locator("pre")).toBeVisible();
    await expect(textbox).toBeFocused();

    await app.window
      .getByRole("button", { name: /Directory launchpad replay/ })
      .first()
      .click();
    await app.window
      .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
      .click();

    await expect(app.window.getByTestId("composer-tiptap-input").locator("pre")).toBeVisible();
    await expect(app.window.getByRole("textbox", { name: "New thread" })).toBeFocused();
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
