import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createComposerDraftPersistenceFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-composer-drafts-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  const fixturePath = path.join(rootDir, "composer-draft-persistence.fixture.json");
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

  const existingThread = {
    id: "thread-existing",
    title: "Existing draft parking thread",
    titleSource: "explicit",
    summary: "Existing thread for draft preservation",
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
  };
  const threadReadResult = {
    entries: [
      {
        type: "message",
        id: "existing-message-1",
        role: "assistant",
        text: "Existing thread is ready.",
      },
    ],
    messages: [
      {
        id: "existing-message-1",
        role: "assistant",
        text: "Existing thread is ready.",
      },
    ],
    lastAssistantMessage: "Existing thread is ready.",
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
          scenario: "composer-draft-persistence-regression",
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
            result: [existingThread],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: threadReadResult,
          },
          {
            id: "turn-completed-refresh",
            kind: "notification",
            notification: {
              method: "turn/completed",
              params: {
                threadId: "thread-existing",
                turnId: "turn-refresh",
                turn: {
                  id: "turn-refresh",
                  status: "completed",
                  output: [],
                },
              },
            },
          },
          {
            id: "thread-list-refresh",
            kind: "response",
            method: "thread/list",
            result: [
              {
                ...existingThread,
                updatedAt: 3_000,
              },
            ],
          },
          {
            id: "thread-read-2",
            kind: "response",
            method: "thread/read",
            result: threadReadResult,
          },
          {
            id: "thread-read-3",
            kind: "response",
            method: "thread/read",
            result: threadReadResult,
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

async function openDirectoryLaunchpad(app: Awaited<ReturnType<typeof launchElectronApp>>) {
  await app.window.getByRole("tab", { name: "directories" }).click();
  await app.window
    .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
    .click();

  await expect(
    app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
  ).toBeVisible();
}

async function openExistingThread(app: Awaited<ReturnType<typeof launchElectronApp>>) {
  await app.window
    .getByRole("button", { name: /Existing draft parking thread/i })
    .first()
    .click();
  await expect(
    app.window.getByRole("heading", {
      level: 2,
      name: "Existing draft parking thread",
    }),
  ).toBeVisible();
}

async function pasteDelayedImage(page: Page, params: {
  accessibleName: "New thread" | "Reply";
  filename: string;
  label: string;
}): Promise<void> {
  await page.evaluate(async ({ accessibleName, filename, label }) => {
    const textbox = Array.from(
      document.querySelectorAll<HTMLElement>('[role="textbox"]'),
    ).find((element) => element.getAttribute("aria-label") === accessibleName);
    if (!textbox) {
      throw new Error(`${accessibleName} Tiptap textbox not found`);
    }

    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function delayedToBlob(callback, type, quality) {
      window.setTimeout(() => {
        originalToBlob.call(this, callback, type, quality);
      }, 500);
    };

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 900;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas context not available");
      }
      context.fillStyle = "#245b55";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f8fafc";
      context.font = "96px sans-serif";
      context.fillText(label, 96, 180);

      const blob = await new Promise<Blob>((resolve, reject) => {
        originalToBlob.call(
          canvas,
          (value) => {
            if (!value) {
              reject(new Error("Could not create PNG blob"));
              return;
            }
            resolve(value);
          },
          "image/png",
        );
      });
      const file = new File([blob], filename, { type: "image/png" });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      textbox.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    } finally {
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
  }, params);
}

async function pastePlainText(page: Page, params: {
  accessibleName: "New thread" | "Reply";
  html?: string;
  text: string;
}): Promise<void> {
  await page.evaluate(({ accessibleName, html, text }) => {
    const textbox = Array.from(
      document.querySelectorAll<HTMLElement>('[role="textbox"]'),
    ).find((element) => element.getAttribute("aria-label") === accessibleName);
    if (!textbox) {
      throw new Error(`${accessibleName} Tiptap textbox not found`);
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", text);
    if (html) {
      dataTransfer.setData("text/html", html);
    }
    textbox.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      }),
    );
  }, params);
}

test("keeps Tiptap launchpad and reply drafts with pasted images across switching and refresh", async () => {
  const fixture = await createComposerDraftPersistenceFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    const launchpadDraft = "Launchpad draft text before refresh";
    const replyDraft = "Reply draft text before refresh";

    await openDirectoryLaunchpad(app);
    let tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "New thread" }).fill(launchpadDraft);
    await expect(tiptapInput).toHaveAttribute("data-value", launchpadDraft);
    await pasteDelayedImage(app.window, {
      accessibleName: "New thread",
      filename: "launchpad-draft.png",
      label: "launchpad draft",
    });

    await openExistingThread(app);
    tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "Reply" }).fill(replyDraft);
    await expect(tiptapInput).toHaveAttribute("data-value", replyDraft);
    await pasteDelayedImage(app.window, {
      accessibleName: "Reply",
      filename: "reply-draft.png",
      label: "reply draft",
    });

    await app.advance({ stepId: "turn-completed-refresh" });
    await app.window.waitForTimeout(700);

    await openDirectoryLaunchpad(app);
    tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await expect(tiptapInput).toHaveAttribute("data-value", launchpadDraft);
    await expect(app.window.getByLabel("Pasted images")).toHaveCount(1);
    await expect(app.window.getByAltText("launchpad-draft.png")).toBeVisible();

    await openExistingThread(app);
    tiptapInput = app.window.getByTestId("composer-tiptap-input");
    await expect(tiptapInput).toHaveAttribute("data-value", replyDraft);
    await expect(app.window.getByLabel("Pasted images")).toHaveCount(1);
    await expect(app.window.getByAltText("reply-draft.png")).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("keeps every pasted line inside the active Tiptap code block", async () => {
  const fixture = await createComposerDraftPersistenceFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await openExistingThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    await app.window.keyboard.type("```");
    await app.window.keyboard.press("Space");

    const pastedText = [
      " 1) e2e/library-source-filter.spec.ts:74:1 › source-app filters load captures outside the initial virtualized page ",
      "",
      "",
      "Test timeout of 180000ms exceeded.",
      "",
      "",
      "    Error Context: test-results/library-source-filter-sour-7c26e-he-initial-virtualized-page/error-context.md",
    ].join("\n");

    await pastePlainText(app.window, {
      accessibleName: "Reply",
      html: [
        "<div> 1) e2e/library-source-filter.spec.ts:74:1 › source-app filters load captures outside the initial virtualized page </div>",
        "<div><br></div>",
        "<div><br></div>",
        "<div>Test timeout of 180000ms exceeded.</div>",
        "<div><br></div>",
        "<div><br></div>",
        "<div>&nbsp;&nbsp;&nbsp;&nbsp;Error Context: test-results/library-source-filter-sour-7c26e-he-initial-virtualized-page/error-context.md</div>",
      ].join(""),
      text: pastedText,
    });

    await expect(tiptapInput.locator("pre")).toHaveCount(1);
    await expect(tiptapInput.locator("pre")).toContainText(
      "Test timeout of 180000ms exceeded.",
    );
    await expect(
      tiptapInput.locator("p", {
        hasText: /Test timeout|Error Context|source-app/,
      }),
    ).toHaveCount(0);
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      `\`\`\`\n${pastedText}\n\`\`\``,
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("keeps every pasted line inside the active Tiptap block quote", async () => {
  const fixture = await createComposerDraftPersistenceFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await openExistingThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    await app.window.keyboard.type("> ");

    const pastedText = [
      "first quoted line",
      "",
      "second quoted line after a blank",
      "third quoted line",
    ].join("\n");

    await pastePlainText(app.window, {
      accessibleName: "Reply",
      text: pastedText,
    });

    await expect(tiptapInput.locator("blockquote")).toHaveCount(1);
    await expect(tiptapInput.locator("blockquote")).toContainText(
      "second quoted line after a blank",
    );
    await expect(tiptapInput.locator("> p")).toHaveCount(0);
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      [
        "> first quoted line",
        "> ",
        "> second quoted line after a blank",
        "> third quoted line",
      ].join("\n"),
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("restores an already-open Tiptap WYSIWYG reply as rendered markdown after switching away", async () => {
  const fixture = await createComposerDraftPersistenceFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await openExistingThread(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    await app.window.keyboard.type("```ts ");
    await app.window.keyboard.type("const threadId = 'thread-existing';");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("return threadId;");

    const expectedMarkdown =
      "```ts\nconst threadId = 'thread-existing';\nreturn threadId;\n```";
    await expect(
      tiptapInput.locator("pre", {
        hasText: "const threadId = 'thread-existing';\nreturn threadId;",
      }),
    ).toBeVisible();
    await expect(tiptapInput).toHaveAttribute("data-value", expectedMarkdown);

    await openDirectoryLaunchpad(app);
    await openExistingThread(app);

    const restoredTiptapInput = app.window.getByTestId("composer-tiptap-input");
    await expect(restoredTiptapInput).toHaveAttribute(
      "data-value",
      expectedMarkdown,
    );
    await expect(
      restoredTiptapInput.locator("pre", {
        hasText: "const threadId = 'thread-existing';\nreturn threadId;",
      }),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("recovers an accidentally deleted Tiptap reply draft from another blank composer", async () => {
  const fixture = await createComposerDraftPersistenceFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await openExistingThread(app);

    const deletedDraft =
      "This is a long unsent reply draft typed into the real Tiptap editor. " +
      "It should be recoverable with ArrowUp after an accidental select-all delete " +
      "instead of disappearing when the composer becomes empty.";
    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "Reply" });

    await textbox.focus();
    await app.window.keyboard.type(deletedDraft);
    await expect(tiptapInput).toHaveAttribute("data-value", deletedDraft);

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Backspace");
    await expect(tiptapInput).toHaveAttribute("data-value", "");

    await openDirectoryLaunchpad(app);
    const launchpadInput = app.window.getByTestId("composer-tiptap-input");
    await app.window.getByRole("textbox", { name: "New thread" }).focus();
    await expect(launchpadInput).toHaveAttribute("data-value", "");

    await app.window.keyboard.press("ArrowUp");
    await expect(launchpadInput).toHaveAttribute("data-value", deletedDraft);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
