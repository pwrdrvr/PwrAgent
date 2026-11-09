import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { StartThreadRequest, StartThreadResponse } from "@pwragent/shared";
import { StateDb } from "../src/main/state/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { mastheadAction } from "./fixtures/window-chrome";

async function createNewThreadTranscriptFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-new-thread-sync-"));
  const fixturePath = path.join(rootDir, "new-thread-transcript-sync.fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "new-thread-transcript-sync",
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
                title: "Existing Codex thread",
                titleSource: "explicit",
                summary: "Already in the list",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: true,
                  reason: "new-thread",
                },
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
                  text: "Existing Codex thread",
                },
              ],
              messages: [
                {
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing Codex thread",
                },
              ],
              lastAssistantMessage: "Existing Codex thread",
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
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            afterResponseId: "thread-start-1",
            result: [
              {
                id: "thread-existing",
                title: "Existing Codex thread",
                titleSource: "explicit",
                summary: "Already in the list",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false,
                },
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-read-2",
            kind: "response",
            method: "thread/read",
            // The empty read belongs to the new thread, not to a startup reread.
            afterResponseId: "thread-start-1",
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
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-new",
              turnId: "turn-new-1",
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
                  text: "Let's test creating a new thread again",
                },
                {
                  type: "message",
                  id: "thread-new-message-2",
                  role: "assistant",
                  text: "The assistant reply finally showed up.",
                },
              ],
              messages: [
                {
                  id: "thread-new-message-1",
                  role: "user",
                  text: "Let's test creating a new thread again",
                },
                {
                  id: "thread-new-message-2",
                  role: "assistant",
                  text: "The assistant reply finally showed up.",
                },
              ],
              lastAssistantMessage: "The assistant reply finally showed up.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-list-3",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-new",
                title: "Let's test creating a new thread again",
                titleSource: "derived",
                summary: undefined,
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: true,
                  reason: "new-thread",
                },
                updatedAt: 2_000,
              },
              {
                id: "thread-existing",
                title: "Existing Codex thread",
                titleSource: "explicit",
                summary: "Already in the list",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false,
                },
                updatedAt: 1_000,
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

async function createNewThreadFocusFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-new-thread-focus-"));
  const fixturePath = path.join(rootDir, "new-thread-focus.fixture.json");

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "new-thread-focus",
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
                title: "Existing focus target",
                titleSource: "explicit",
                summary: "This is the thread the user picks second.",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false,
                },
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
                  text: "Existing focus target is selected.",
                },
              ],
              messages: [
                {
                  id: "thread-existing-message-1",
                  role: "assistant",
                  text: "Existing focus target is selected.",
                },
              ],
              lastAssistantMessage: "Existing focus target is selected.",
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
            id: "thread-list-2",
            kind: "response",
            method: "thread/list",
            afterResponseId: "thread-start-1",
            result: [
              {
                id: "thread-new",
                title: "Fresh focus thread",
                titleSource: "derived",
                summary: undefined,
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: true,
                  reason: "new-thread",
                },
                updatedAt: 2_000,
              },
              {
                id: "thread-existing",
                title: "Existing focus target",
                titleSource: "explicit",
                summary: "This is the thread the user picks second.",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false,
                },
                updatedAt: 1_000,
              },
            ],
          },
          {
            id: "thread-read-2",
            kind: "response",
            method: "thread/read",
            // The empty read belongs to the new thread, not to a startup reread.
            afterResponseId: "thread-start-1",
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
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-new",
              turnId: "turn-new-1",
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

test("removes a prepared worktree after creation isolation refuses admission", async () => {
  const fixture = await createNewThreadTranscriptFixture();
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-creation-refusal-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture repository");
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });
  try {
    const before = git("worktree", "list", "--porcelain");
    const error = await app.window.evaluate(async (cwd) => {
      try {
        const api = (window as typeof window & { pwragent: { startThread(request: StartThreadRequest): Promise<StartThreadResponse> } }).pwragent;
        await api.startThread({ backend: "codex", cwd, workMode: "worktree", mcpProviderServersEnabled: false });
        return "accepted";
      } catch (failure) { return failure instanceof Error ? failure.message : String(failure); }
    }, repo);
    expect(error).toContain("cannot report its configured MCP servers");
    expect(git("worktree", "list", "--porcelain")).toBe(before);
    // The refusal precedes the fixture's single-use thread/start response.
    // A later ordinary send must still create and complete that thread.
    await mastheadAction(app.window, "New thread").click();
    await app.window.getByRole("textbox", { name: "New thread" }).fill("Let's test creating a new thread again");
    await app.window.getByRole("button", { name: "Start thread" }).click();
    await expect.poll(async () => await app.getLastStartTurn()).toMatchObject({ threadId: "thread-new" });
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-completed-1" });
    await expect(app.window.getByRole("region", { name: "Transcript" }).getByText("The assistant reply finally showed up.")).toBeVisible();
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.cleanup();
    await rm(repo, { recursive: true, force: true });
  }
});

test("reveals a new root in a collapsed directory when SQLite refuses its parent relationship", async () => {
  const fixture = await createNewThreadTranscriptFixture();
  const cwd = path.dirname(fixture.fixturePath);
  const directoryKey = `directory:${cwd}`;
  const replay = JSON.parse(await readFile(fixture.fixturePath, "utf8")) as ReplayFixture;
  for (const step of replay.steps) {
    if (step.kind === "response" && step.method === "thread/list" && Array.isArray(step.result)) {
      for (const row of step.result) row.linkedDirectories = [{ id: directoryKey, kind: "local", label: "Creation visibility fixture", path: cwd }];
    }
  }
  await writeFile(fixture.fixturePath, JSON.stringify(replay));
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath, preLaunchHook: async (homeRoot) => {
    const state = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
    try {
      const overlay = new SqliteOverlayStore(state);
      await overlay.setThreadPin({ backend: "codex", threadId: "thread-existing", pinnedRank: "1024" });
      await overlay.setSubthreadsCollapsed({ backend: "codex", parentThreadId: "thread-existing", collapsed: true });
      await overlay.setDirectoryThreadsCollapsed({ directoryKey, collapsed: true });
    } finally { state.close(); }
  } });
  const db = new Database(stateDbPathForHomeRoot(app.homeRoot));
  try {
    await expect(app.window.getByRole("heading", { level: 2, name: "Existing Codex thread" })).toBeVisible();
    await app.window.getByRole("tab", { name: "directories" }).click();
    const directory = app.window.locator(".directory-row").filter({ has: app.window.getByRole("button", { name: /Existing Codex thread/ }) });
    const pinnedRows = directory.locator('.thread-row-shell[data-thread-pin-state="pinned"]');
    await expect(pinnedRows).toHaveCount(1);
    db.exec(`CREATE TRIGGER refuse_creation_parent BEFORE INSERT ON threads
      WHEN json_extract(NEW.payload, '$.threadId') = 'thread-new'
        AND json_type(NEW.payload, '$.parentThreadId') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Fixture creation parent refused'); END`);
    const created = await app.window.evaluate(async (cwd) => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const request = { backend: "codex" as const, cwd, parentThreadId: "thread-existing", agent: { name: "Accepted root fixture" } };
      return await api.startThread!(request);
    }, cwd);
    expect(created).toMatchObject({ backend: "codex", threadId: "thread-new", pinnedRank: expect.any(String) });
    await expect(pinnedRows).toHaveCount(2);
    await expect(directory.getByRole("button", { name: /Accepted root fixture/ }).first()).toBeVisible();
    const saved = db.prepare("SELECT payload FROM threads WHERE json_extract(payload, '$.threadId') = ?").get("thread-new") as { payload: string };
    expect(JSON.parse(saved.payload)).not.toHaveProperty("parentThreadId");
    const parent = db.prepare("SELECT payload FROM threads WHERE json_extract(payload, '$.threadId') = ?").get("thread-existing") as { payload: string };
    expect(JSON.parse(parent.payload)).toHaveProperty("subthreadsCollapsed", true);
  } finally {
    db.close();
    await app.close();
    await fixture.cleanup();
  }
});

test("completes a new thread after SQLite refuses post-creation PR metadata", async () => {
  const fixture = await createNewThreadTranscriptFixture();
  const app = await launchElectronApp({ fixturePath: fixture.fixturePath });
  const output: string[] = [];
  const collect = (chunk: Buffer) => { output.push(chunk.toString()); };
  app.electronApp.process().stdout?.on("data", collect);
  app.electronApp.process().stderr?.on("data", collect);
  const db = new Database(stateDbPathForHomeRoot(app.homeRoot));
  try {
    db.exec(`CREATE TRIGGER refuse_creation_pr BEFORE INSERT ON threads
      WHEN json_extract(NEW.payload, '$.threadId') = 'thread-new'
        AND json_type(NEW.payload, '$.prAutoDispatchEnabled') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'Fixture creation PR metadata refused'); END`);
    await mastheadAction(app.window, "New thread").click();
    await app.window.getByRole("textbox", { name: "New thread" }).fill("Let's test creating a new thread again");
    await app.window.getByRole("button", { name: "Start thread" }).click();
    await app.window.getByRole("region", { name: "Transcript", exact: true }).waitFor();
    await expect.poll(async () => await app.getLastStartTurn()).toMatchObject({ threadId: "thread-new" });
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await expect.poll(() => output.join("")).toContain("Fixture creation PR metadata refused");
    expect(output.join("")).toContain("thread creation lifecycle effect failed");
    expect(output.join("")).toContain("stage=pr");
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-completed-1" });
    await expect(app.window.getByRole("region", { name: "Transcript" }).getByText("The assistant reply finally showed up.")).toBeVisible();
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    await expect(app.window.getByRole("heading", { level: 2, name: "Let's test creating a new thread again" })).toBeVisible();
  } finally {
    db.close();
    await app.close();
    await fixture.cleanup();
  }
});

test("top-level new thread rereads the created thread until the assistant reply is hydrated", async () => {
  const fixture = await createNewThreadTranscriptFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("Existing Codex thread"),
    ).toBeVisible();

    await mastheadAction(app.window, "New thread").click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "New thread" }),
    ).toBeVisible();

    await app.window
      .getByRole("textbox", { name: "New thread" })
      .fill("Let's test creating a new thread again");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    // Submission first renders a separate Preparing transcript region. Wait
    // for startup to hand ownership to the real transcript before checking it.
    await app.window.getByRole("region", { name: "Transcript", exact: true }).waitFor();
    await expect(
      app.window
        .getByRole("region", { name: "Transcript" })
        .getByText("Let's test creating a new thread again"),
    ).toBeVisible();
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("No thread history yet."),
    ).toBeHidden();

    await app.advance({ stepId: "turn-started-1" });
    await expect(
      app.window
        .getByRole("region", { name: "Transcript" })
        .getByText("Let's test creating a new thread again"),
    ).toBeVisible();
    await app.advance({ stepId: "turn-completed-1" });

    await expect(
      app.window.getByRole("heading", { level: 2, name: "Let's test creating a new thread again" }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("region", { name: "Transcript" }).getByText("Let's test creating a new thread again"),
    ).toBeVisible();
    await expect(
      app.window
        .getByRole("region", { name: "Transcript" })
        .getByText("The assistant reply finally showed up."),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("top-level new thread cycles deleted no-project drafts only from the recovery caret", async () => {
  const fixture = await createNewThreadTranscriptFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await mastheadAction(app.window, "New thread").click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "New thread" }),
    ).toBeVisible();

    const deletedDraft = [
      "Somebody once told me",
      "",
      "",
      "The world is gonna roll me",
      "",
      "",
      "I ain't the sharpest tool in the shed",
      "",
      "",
      "```",
      "// This is a tool",
      "```",
      "",
      "",
      "- This is",
      "- Not exactly a tool",
    ].join("\n");
    const earlierDraft = [
      "Earlier coherent draft",
      "",
      "This one should be the second recovery candidate after the newest deleted draft is restored.",
      "",
      "It is intentionally long enough to qualify as a complete abandoned draft rather than a tiny intermediate edit.",
    ].join("\n");
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });

    await textbox.fill(earlierDraft);
    await expect(tiptapInput).toHaveAttribute("data-value", /Earlier coherent draft/);
    const storedEarlierDraft = await tiptapInput.getAttribute("data-value");
    expect(storedEarlierDraft).toContain(
      "This one should be the second recovery candidate after the newest deleted draft is restored.",
    );
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Backspace");
    await expect(tiptapInput).toHaveAttribute("data-value", "");

    await textbox.fill(deletedDraft);
    await expect(tiptapInput).toHaveAttribute("data-value", /Somebody once told me/);
    const storedDraft = await tiptapInput.getAttribute("data-value");
    expect(storedDraft).toContain("The world is gonna roll me");
    expect(storedDraft).toContain("// This is a tool");
    expect(storedDraft).toContain("- Not exactly a tool");

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Backspace");

    await app.window.keyboard.press("ArrowUp");
    await expect(tiptapInput).toHaveAttribute("data-value", storedDraft ?? "");
    await expect
      .poll(async () =>
        await textbox.evaluate(
          (node) =>
            (node as HTMLElement & { selectionStart: number }).selectionStart,
        )
      )
      .toBe(0);

    await app.window.keyboard.press("ArrowUp");
    await expect(tiptapInput).toHaveAttribute("data-value", storedEarlierDraft ?? "");
    await expect
      .poll(async () =>
        await textbox.evaluate(
          (node) =>
            (node as HTMLElement & { selectionStart: number }).selectionStart,
        )
      )
      .toBe(0);

    await app.window.keyboard.press("ArrowDown");
    await expect(tiptapInput).toHaveAttribute("data-value", storedDraft ?? "");
    await expect
      .poll(async () =>
        await textbox.evaluate(
          (node) =>
            (node as HTMLElement & { selectionStart: number }).selectionStart,
        )
      )
      .toBe(0);

    await app.window.keyboard.press("ArrowUp");
    await expect(tiptapInput).toHaveAttribute("data-value", storedEarlierDraft ?? "");

    await app.window.keyboard.press("ArrowRight");
    await app.window.keyboard.press("ArrowDown");
    await expect(tiptapInput).toHaveAttribute("data-value", storedEarlierDraft ?? "");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("does not move focus back to a new thread after the user selects another thread", async () => {
  const fixture = await createNewThreadFocusFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Existing focus target" }),
    ).toBeVisible();

    await app.window.evaluate(() => {
      const api = (
        window as typeof window & {
          pwragent: { getNavigationQueryPage: (request: { query: { kind: string } }, consumerId?: string) => Promise<unknown> };
        }
      ).pwragent;
      const originalGetNavigationQueryPage = api.getNavigationQueryPage.bind(api);
      let releaseRefresh: (() => void) | undefined;
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });

      api.getNavigationQueryPage = async (request, consumerId) => {
        if (request.query.kind !== "exact") {
          await refreshGate;
        }
        return await originalGetNavigationQueryPage(request, consumerId);
      };
      (
        window as typeof window & { __releaseFocusRegressionRefresh?: () => void }
      ).__releaseFocusRegressionRefresh = () => {
        releaseRefresh?.();
      };
    });

    await mastheadAction(app.window, "New thread").click();
    await app.window
      .getByRole("textbox", { name: "New thread" })
      .fill("Start the focus regression thread");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    await expect(
      app.window.getByRole("heading", { level: 2, name: "Fresh focus thread" }),
    ).toBeVisible();

    await app.window
      .getByRole("button", { name: /Existing focus target/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Existing focus target" }),
    ).toBeVisible();

    await app.window.evaluate(() => {
      (
        window as typeof window & { __releaseFocusRegressionRefresh?: () => void }
      ).__releaseFocusRegressionRefresh?.();
    });

    await expect
      .poll(async () => await app.getLastStartTurn())
      .toMatchObject({ threadId: "thread-new" });
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Existing focus target" }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("heading", { level: 2, name: "Fresh focus thread" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
