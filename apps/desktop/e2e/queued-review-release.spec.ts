import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { probeReport } from "./fixtures/probe-report";

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

/**
 * Why the Send button is still disabled, read after the wait ran out.
 *
 * `sendButtonDisabled` is an OR of four terms and the DOM publishes none of
 * them, so a bare "Received: disabled" cannot tell the two candidates apart:
 *
 *  - The composer's authorization was withdrawn after the fill landed — the
 *    thread view's `composerDisabled` covers navigation detail, thread
 *    configuration, queue readiness, and backend availability. Then the
 *    editor is `contenteditable="false"` and carries `is-disabled`, and the
 *    text the fill wrote is still in it.
 *  - The fill never reached the composer this button belongs to, or its
 *    content was lost. Then the editor is editable and empty, and
 *    `getByRole("textbox", { name: "Reply" })` may have matched something
 *    else — role names match as a normalized substring, so any later textbox
 *    whose name merely contains "Reply" is a candidate.
 *
 * Electron traces carry no DOM snapshots, so a failure that is not described
 * here is not described anywhere.
 */
async function describeDisabledSend(page: Page): Promise<string> {
  const observed = await page.evaluate(() => {
    const editors = [...document.querySelectorAll<HTMLElement>("[role='textbox']")]
      .map((editor) => ({
        label: editor.getAttribute("aria-label"),
        contenteditable: editor.getAttribute("contenteditable"),
        className: editor.className,
        text: (editor.textContent ?? "").trim().slice(0, 60),
      }));
    const submits = [...document.querySelectorAll<HTMLButtonElement>("button[type='submit']")]
      .map((button) => ({
        label: (button.textContent ?? "").trim(),
        disabled: button.disabled,
        className: button.className,
      }));
    return {
      editors,
      submits,
      attachments: document.querySelectorAll(".composer__attachment").length,
      turnActive: Boolean(document.querySelector("[data-testid='composer-stop-turn']")),
    };
  });

  return [
    `  textboxes: ${JSON.stringify(observed.editors)}`,
    `  submit buttons: ${JSON.stringify(observed.submits)}`,
    `  composer attachments=${observed.attachments}`
    + ` stop-turn present=${observed.turnActive}`,
  ].join("\n");
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
    await expect(app.window.getByRole("button", { name: "Send", exact: true }))
      .toBeEnabled()
      .catch(async (error: unknown) => {
        throw new Error(
          [
            "Send stayed disabled after the composer accepted the keystroke.",
            await probeReport(async () => await describeDisabledSend(app.window)),
          ].join("\n"),
          { cause: error },
        );
      });
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
