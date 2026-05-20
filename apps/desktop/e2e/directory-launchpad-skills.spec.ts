import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

async function createDirectoryLaunchpadSkillsFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  repoDir: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-launchpad-skills-"));
  const repoDir = path.join(rootDir, "FixtureRepo");
  await mkdir(repoDir, { recursive: true });
  const generatedSkills = Array.from({ length: 24 }, (_, index) => {
    const skillNumber = String(index + 1).padStart(2, "0");
    return {
      name: `zz-scroll-skill-${skillNumber}`,
      description: `Generated skill ${skillNumber} for autocomplete overflow coverage.`,
      path: path.join(
        rootDir,
        `.codex/skills/zz-scroll-skill-${skillNumber}/SKILL.md`,
      ),
      enabled: true,
      scope: "user",
    };
  });

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
                    name: "ce:brainstorm",
                    description: "Explore requirements before writing implementation plans.",
                    path: "/Users/huntharo/.codex/skills/ce-brainstorm/SKILL.md",
                    enabled: true,
                    scope: "user",
                  },
                  {
                    name: "ce:plan",
                    description: "Transform requirements into implementation plans.",
                    path: "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
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
                  ...generatedSkills,
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
    repoDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function seedPersistedDirectoryLaunchpad(params: {
  repoDir: string;
  stateRoot: string;
}): Promise<void> {
  await mkdir(params.stateRoot, { recursive: true });
  const directoryKey = `directory:${params.repoDir}`;
  await writeFile(
    path.join(params.stateRoot, "overlay-state.json"),
    JSON.stringify(
      {
        version: 5,
        backends: {},
        launchpadDefaults: {
          backend: "codex",
          executionMode: "full-access",
          workMode: "worktree",
          reasoningEffort: "high",
        },
        directoryLaunchpads: {
          [directoryKey]: {
            directoryKey,
            directoryKind: "directory",
            directoryLabel: "FixtureRepo",
            directoryPath: params.repoDir,
            backend: "codex",
            executionMode: "full-access",
            prompt: "[$ce:brainstorm](/Users/huntharo/.codex/skills/ce-brainstorm/SKILL.md) ",
            workMode: "worktree",
            branchName: "main",
            reasoningEffort: "high",
            createdAt: 1760000000000,
            updatedAt: 1760000000000,
          },
        },
        threads: {},
      },
      null,
      2,
    ),
    "utf8",
  );
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

async function typeSkillChip(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
  triggerText: string,
  optionName: RegExp,
) {
  await app.window.keyboard.type(triggerText);
  const option = app.window.getByRole("button", { name: optionName });
  await option.focus();
  await expect(option).toBeFocused();
  await app.window.keyboard.press("Enter");
  await expect(app.window.getByRole("textbox", { name: "New thread" })).toBeFocused();
}

function getLaunchpadComposer(app: Awaited<ReturnType<typeof launchElectronApp>>) {
  return {
    root: app.window.getByTestId("composer-tiptap-input"),
    textbox: app.window.getByRole("textbox", { name: "New thread" }),
  };
}

test("directory launchpad loads skill autocomplete from user and local scope", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

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

test("directory launchpad keyboard typing updates the composer once", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await app.window.keyboard.type("$ce");

    await expect
      .poll(async () =>
        await textbox.evaluate((element) => (element as HTMLDivElement).textContent)
      )
      .toBe("$ce");
    await expect(
      app.window.getByRole("button", { name: /\$ce:brainstorm/i }),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad skill autocomplete supports active keyboard selection", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const { root: richInput, textbox } = getLaunchpadComposer(app);
    await textbox.focus();
    await app.window.keyboard.type("$");

    const listbox = app.window.getByRole("listbox", { name: "Skills" });
    await expect(listbox).toBeVisible();
    // The composer follows the ARIA 1.2 textbox + autocomplete pattern:
    // popup state is conveyed via aria-controls toggling (set to the
    // listbox id when open, removed when closed), NOT aria-expanded —
    // which the spec disallows on role="textbox". See the rationale
    // in ComposerTiptapInput.tsx where the attributes are declared.
    const listboxId = await listbox.getAttribute("id");
    expect(listboxId).toBeTruthy();
    await expect(textbox).toHaveAttribute("aria-controls", listboxId ?? "");

    const firstActiveOption = listbox.locator('[aria-selected="true"]');
    const firstActiveOptionId = await firstActiveOption.getAttribute("id");
    expect(firstActiveOptionId).toBeTruthy();
    await expect(textbox).toHaveAttribute(
      "aria-activedescendant",
      firstActiveOptionId ?? "",
    );
    await expect(firstActiveOption).toHaveCSS("background-color", "rgb(18, 8, 0)");
    await expect(firstActiveOption).not.toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect
      .poll(() =>
        firstActiveOption.evaluate(
          (element) => getComputedStyle(element, "::before").width,
        )
      )
      .toBe("3px");

    await app.window.keyboard.press("ArrowDown");
    const secondActiveOption = listbox.locator('[aria-selected="true"]');
    await expect
      .poll(async () => await secondActiveOption.getAttribute("id"))
      .not.toBe(firstActiveOptionId);
    const secondActiveOptionId = await secondActiveOption.getAttribute("id");
    expect(secondActiveOptionId).toBeTruthy();
    const secondActiveSkillLabel = (
      (await secondActiveOption
        .locator(".composer__autocomplete-title")
        .textContent())?.match(/\$[A-Za-z0-9:_-]+/)?.[0] ??
      ""
    );
    expect(secondActiveSkillLabel).toBeTruthy();
    await expect(textbox).toHaveAttribute(
      "aria-activedescendant",
      secondActiveOptionId ?? "",
    );

    await app.window.keyboard.press("Tab");
    await expect(listbox).toBeHidden();
    await expect(
      richInput.locator(".skill-chip", { hasText: secondActiveSkillLabel }),
    ).toBeVisible();

    await textbox.focus();
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Delete");
    await expect(richInput).toHaveAttribute("data-value", "");
    await expect(richInput.locator(".skill-chip")).toHaveCount(0);

    await app.window.keyboard.type("$ce:pl");
    await app.window.keyboard.press("Enter");
    await expect(
      richInput.locator(".skill-chip", { hasText: "$ce:plan" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap composer keeps placeholder on the caret line", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await expect(tiptapInput).toHaveClass(/is-empty/);

    const metrics = await tiptapInput.evaluate((element) => {
      const editor = element.querySelector<HTMLElement>(
        ".composer-tiptap-input__editor",
      );
      const paragraph = editor?.querySelector<HTMLElement>("p");
      if (!editor || !paragraph) {
        throw new Error("Expected empty Tiptap editor paragraph");
      }

      const editorRect = editor.getBoundingClientRect();
      const paragraphRect = paragraph.getBoundingClientRect();
      const editorStyle = getComputedStyle(editor);
      const placeholderStyle = getComputedStyle(editor, "::before");

      return {
        paragraphOffsetTop: paragraphRect.top - editorRect.top,
        placeholderContent: placeholderStyle.content,
        placeholderPosition: placeholderStyle.position,
        placeholderTop: Number.parseFloat(placeholderStyle.top),
        paddingTop: Number.parseFloat(editorStyle.paddingTop),
      };
    });

    expect(metrics.placeholderContent).toContain("Start a new thread in FixtureRepo");
    expect(metrics.placeholderPosition).toBe("absolute");
    expect(Math.abs(metrics.placeholderTop - metrics.paddingTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.paragraphOffsetTop - metrics.paddingTop)).toBeLessThanOrEqual(
      1,
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap WYSIWYG composer serializes markdown blocks", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    await expect(app.window.locator(".composer")).toHaveAttribute(
      "data-composer-implementation",
      "tiptap-wysiwyg-markdown-chips",
    );

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await app.window.keyboard.type("## Heading");

    const heading2 = tiptapInput.locator("h2", { hasText: "Heading" });
    await expect(heading2).toBeVisible();
    await expect(tiptapInput).toHaveAttribute("data-value", "## Heading");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("plain text");
    await expect(tiptapInput.locator("h2", { hasText: "plain text" })).toHaveCount(0);
    await expect(tiptapInput.locator("p", { hasText: "plain text" })).toBeVisible();
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "## Heading\n\nplain text",
    );

    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("### Smaller heading");

    const heading3 = tiptapInput.locator("h3", { hasText: "Smaller heading" });
    await expect(heading3).toBeVisible();
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("#### Detail heading");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("##### Fine print heading");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("###### Quiet heading");

    const heading4 = tiptapInput.locator("h4", { hasText: "Detail heading" });
    const heading5 = tiptapInput.locator("h5", { hasText: "Fine print heading" });
    const heading6 = tiptapInput.locator("h6", { hasText: "Quiet heading" });
    await expect(heading4).toBeVisible();
    await expect(heading5).toBeVisible();
    await expect(heading6).toBeVisible();
    const headingStyles = await Promise.all(
      [heading2, heading3, heading4, heading5, heading6].map((heading) =>
        heading.evaluate((element) => {
          const styles = getComputedStyle(element);
          return {
            fontSize: Number.parseFloat(styles.fontSize),
            fontStyle: styles.fontStyle,
          };
        })
      )
    );
    for (let index = 1; index < headingStyles.length; index += 1) {
      expect(headingStyles[index - 1].fontSize).toBeGreaterThan(
        headingStyles[index].fontSize,
      );
    }
    expect(headingStyles[3].fontStyle).toBe("italic");
    expect(headingStyles[4].fontStyle).toBe("italic");
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "## Heading\n\nplain text\n\n### Smaller heading\n\n#### Detail heading\n\n##### Fine print heading\n\n###### Quiet heading",
    );

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Delete");
    await app.window.keyboard.type("```js ");
    await app.window.keyboard.type("const x = 1;");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("return x;");

    const codeBlock = tiptapInput.locator("pre", {
      hasText: "const x = 1;\nreturn x;",
    });
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "```js\nconst x = 1;\nreturn x;\n```",
    );

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Delete");
    await app.window.keyboard.type("Before ");
    await typeSkillChip(app, "$ce:plan", /\$ce:plan/i);
    await app.window.keyboard.type(" after");

    await expect(
      tiptapInput.locator(".composer-tiptap-input__mention", { hasText: "$ce:plan" }),
    ).toBeVisible();
    await expect(tiptapInput).toHaveAttribute("data-value", "Before  after");

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Delete");
    await app.window.keyboard.type("Cats");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("## Later");

    await expect(tiptapInput.locator("h2", { hasText: "Later" })).toBeVisible();
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "Cats\n\n\n\n## Later",
    );

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Delete");
    await app.window.keyboard.type("- Some item");
    await expect(tiptapInput.locator("li", { hasText: "Some item" })).toBeVisible();

    await app.window.keyboard.press("Shift+Enter");
    await app.window.keyboard.type("Second item");

    await expect(tiptapInput.locator("li")).toHaveCount(2);
    await expect(tiptapInput.locator("li", { hasText: "Second item" })).toBeVisible();
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "- Some item\n- Second item",
    );

    await app.window.keyboard.press("Alt+Enter");
    await app.window.keyboard.type("continued");

    await expect(tiptapInput.locator("li")).toHaveCount(2);
    await expect(
      tiptapInput.locator("li", { hasText: /Second item\s*continued/ }),
    ).toBeVisible();
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "- Some item\n- Second item\ncontinued",
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap composer preserves pasted paragraph breaks", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await textbox.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(
        "text/html",
        "<p>first paragraph</p><p>second paragraph</p>",
      );
      dataTransfer.setData("text/plain", "first paragraph\nsecond paragraph");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });

    await expect(
      tiptapInput.locator(".composer-tiptap-input__editor p"),
    ).toHaveCount(2);
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      "first paragraph\n\nsecond paragraph",
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad skill autocomplete honors markdown offsets after formatted blocks", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const { root: tiptapInput, textbox } = getLaunchpadComposer(app);
    await textbox.focus();
    await textbox.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(
        "text/html",
        "<h2>heading</h2><p>$ce:b</p>",
      );
      dataTransfer.setData("text/plain", "## heading\n\n$ce:b");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        }),
      );
    });

    await expect(tiptapInput).toHaveAttribute("data-value", "## heading\n\n$ce:b");
    const listbox = app.window.getByRole("listbox", { name: "Skills" });
    await expect(listbox).toBeVisible();
    const brainstormOption = listbox.getByRole("button", {
      name: /\$ce:brainstorm/i,
    });
    await expect(brainstormOption).toBeVisible();

    await app.window.keyboard.press("Enter");
    await expect(listbox).toBeHidden();
    await expect(
      tiptapInput.locator(".composer-tiptap-input__mention", {
        hasText: "$ce:brainstorm",
      }),
    ).toBeVisible();
    await expect(tiptapInput).toHaveAttribute("data-value", "## heading\n\n");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap composer selects focused skills as undoable inline chips", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await app.window.keyboard.type("$front");

    const option = app.window.getByRole("button", { name: /\$frontend-design/i });
    await option.focus();
    await expect(option).toBeFocused();
    await app.window.keyboard.press("Enter");

    await expect(app.window.getByRole("listbox", { name: "Skills" })).toBeHidden();
    const chip = tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$frontend-design",
    });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute(
      "data-tooltip",
      /\/Users\/huntharo\/\.codex\/skills\/frontend-design\/SKILL\.md$/,
    );
    await expect(tiptapInput).toHaveAttribute("data-value", "");

    await textbox.focus();
    await app.window.keyboard.press("Backspace");
    await expect(chip).toBeHidden();
    await expect(tiptapInput).toHaveAttribute("data-value", "");

    await textbox.focus();
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z",
    );
    await expect(chip).toBeVisible();
    await expect(tiptapInput).toHaveAttribute("data-value", "");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap composer preserves multiple skill chips across boundary edits", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await typeSkillChip(app, "$ce:plan", /\$ce:plan/i);
    await app.window.keyboard.type(" i like cats n dogs - ");
    await typeSkillChip(app, "$ce:brainstorm", /\$ce:brainstorm/i);
    await app.window.keyboard.type(" and more");

    const planChip = tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$ce:plan",
    });
    const brainstormChip = tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$ce:brainstorm",
    });
    await expect(planChip).toBeVisible();
    await expect(brainstormChip).toBeVisible();
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      " i like cats n dogs -  and more",
    );

    const clickPoint = await tiptapInput.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const textNode = Array.from(
        {
          [Symbol.iterator]: function* () {
            let node = walker.nextNode();
            while (node) {
              yield node;
              node = walker.nextNode();
            }
          },
        } as Iterable<Node>,
      ).find((node) => node.nodeValue?.includes("i like cats n dogs"));
      if (!textNode) {
        throw new Error("Expected text between skill chips");
      }

      const offset = textNode.nodeValue?.indexOf("cats") ?? -1;
      if (offset < 0) {
        throw new Error("Expected target word in text node");
      }

      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + 1);
      const rect = range.getBoundingClientRect();
      return {
        x: rect.left + 1,
        y: rect.top + rect.height / 2,
      };
    });

    await app.window.mouse.click(clickPoint.x, clickPoint.y);
    await app.window.keyboard.type("big ");

    await expect(planChip).toBeVisible();
    await expect(brainstormChip).toBeVisible();
    await expect(tiptapInput).toHaveAttribute(
      "data-value",
      " i like big cats n dogs -  and more",
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap composer select all delete clears chips without renderer crash", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.focus();
    await typeSkillChip(app, "$ce:plan", /\$ce:plan/i);
    await app.window.keyboard.type(" i like cats n dogs - ");
    await typeSkillChip(app, "$ce:brainstorm", /\$ce:brainstorm/i);
    await app.window.keyboard.type(" and more");

    await expect(
      tiptapInput.locator(".composer-tiptap-input__mention", { hasText: "$ce:plan" }),
    ).toBeVisible();
    await expect(
      tiptapInput.locator(".composer-tiptap-input__mention", {
        hasText: "$ce:brainstorm",
      }),
    ).toBeVisible();

    await textbox.focus();
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await app.window.keyboard.press("Delete");

    await expect(tiptapInput.locator(".composer-tiptap-input__mention")).toHaveCount(0);
    await expect(tiptapInput).toHaveAttribute("data-value", "");
    await expect(app.window.locator("body")).not.toContainText("Renderer error");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad Tiptap composer deletes a persisted skill chip with repeated backspace", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-tiptap-saved-"));
  // Use the legacy "pwragnt" directory name because the migration code in
  // migration.ts intentionally looks for legacy files at this path.
  const stateRoot = path.join(homeDir, ".local", "state", "pwragnt");
  await seedPersistedDirectoryLaunchpad({
    repoDir: fixture.repoDir,
    stateRoot,
  });
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    env: {      HOME: homeDir,
    },
  });

  try {
    await openDirectoryLaunchpad(app);

    const tiptapInput = app.window.getByTestId("composer-tiptap-input");
    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    const chip = tiptapInput.locator(".composer-tiptap-input__mention", {
      hasText: "$ce:brainstorm",
    });
    await expect(chip).toBeVisible();

    await textbox.focus();
    await app.window.keyboard.press("Backspace");
    await app.window.keyboard.press("Backspace");

    await expect(chip).toBeHidden();
    await expect(tiptapInput).toHaveAttribute("data-value", "");
    await expect(app.window.locator("body")).not.toContainText("Renderer error");
  } finally {
    await app.close();
    await fixture.cleanup();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("directory launchpad skill chips stay text-sized and baseline aligned", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const { root: richInput, textbox } = getLaunchpadComposer(app);
    await textbox.focus();
    await app.window.keyboard.type("before ");
    await typeSkillChip(app, "$ce:plan", /\$ce:plan/i);
    await app.window.keyboard.type(" after");

    const metrics = await richInput.evaluate((element) => {
      const chip = element.querySelector<HTMLElement>(".skill-chip");
      if (!chip) {
        throw new Error("Expected skill chip to render");
      }
      const labelTextNode = Array.from(chip.childNodes).find(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          (node.nodeValue ?? "").includes("$ce:plan"),
      );
      if (!labelTextNode) {
        throw new Error("Expected skill chip label text to render");
      }
      const labelRange = document.createRange();
      labelRange.selectNodeContents(labelTextNode);

      const textRects: DOMRect[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.nodeValue ?? "";
        if (text.includes("before") || text.includes("after")) {
          const range = document.createRange();
          range.selectNodeContents(node);
          textRects.push(...Array.from(range.getClientRects()));
        }
        node = walker.nextNode();
      }
      if (textRects.length === 0) {
        throw new Error("Expected surrounding text to be measurable");
      }

      const labelRect = labelRange.getBoundingClientRect();
      const chipRect = chip.getBoundingClientRect();
      const textStyle = getComputedStyle(element);
      const labelStyle = getComputedStyle(chip);
      const surroundingBottom = textRects.reduce(
        (bottom, rect) => Math.max(bottom, rect.bottom),
        0,
      );
      const surroundingTop = textRects.reduce(
        (top, rect) => Math.min(top, rect.top),
        Number.POSITIVE_INFINITY,
      );

      return {
        chipHeight: chipRect.height,
        fontSize: textStyle.fontSize,
        labelBottom: labelRect.bottom,
        labelFontSize: labelStyle.fontSize,
        labelTop: labelRect.top,
        surroundingBottom,
        surroundingTop,
      };
    });

    expect(metrics.labelFontSize).toBe(metrics.fontSize);
    expect(Math.abs(metrics.labelTop - metrics.surroundingTop)).toBeLessThanOrEqual(2);
    expect(Math.abs(metrics.labelBottom - metrics.surroundingBottom)).toBeLessThanOrEqual(
      2,
    );
    expect(metrics.chipHeight).toBeLessThanOrEqual(22);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad types at the clicked text caret between skill chips", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const { root: richInput, textbox } = getLaunchpadComposer(app);
    await textbox.focus();
    await typeSkillChip(app, "$ce:brainstorm", /\$ce:brainstorm/i);
    await app.window.keyboard.type(" Cats like hats. ");
    await typeSkillChip(app, "$ce:plan", /\$ce:plan/i);
    await expect(richInput).toHaveAttribute("data-value", " Cats like hats. ");

    const clickPoint = await richInput.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const textNode = Array.from(
        {
          [Symbol.iterator]: function* () {
            let node = walker.nextNode();
            while (node) {
              yield node;
              node = walker.nextNode();
            }
          },
        } as Iterable<Node>,
      ).find((node) => node.nodeValue?.includes("Cats like hats"));
      if (!textNode) {
        throw new Error("Expected text between skill chips");
      }

      const offset = textNode.nodeValue?.indexOf("hats") ?? -1;
      if (offset < 0) {
        throw new Error("Expected target word in text node");
      }

      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + 1);
      const rect = range.getBoundingClientRect();
      return {
        x: rect.left + 1,
        y: rect.top + rect.height / 2,
      };
    });

    await app.window.mouse.click(clickPoint.x, clickPoint.y);
    await app.window.keyboard.type("I");
    await expect(richInput).toHaveAttribute("data-value", " Cats like Ihats. ");
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad does not intercept macOS ctrl-a as select all", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const { root: richInput, textbox } = getLaunchpadComposer(app);
    await textbox.focus();
    await app.window.keyboard.type("alpha beta");
    const shortcutResults = await textbox.evaluate((element) => {
      const originalPlatformDescriptor =
        Object.getOwnPropertyDescriptor(window.navigator, "platform") ??
        Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
      const setPlatform = (platform: string): void => {
        Object.defineProperty(window.navigator, "platform", {
          configurable: true,
          value: platform,
        });
      };
      const dispatchShortcut = (init: KeyboardEventInit): boolean =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "a",
            ...init,
          }),
        );

      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "MacIntel",
      });
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const macCtrlAWasNotPrevented = dispatchShortcut({ ctrlKey: true });
      const macMetaAWasNotPrevented = dispatchShortcut({ metaKey: true });
      setPlatform("Linux x86_64");
      const linuxCtrlAWasNotPrevented = dispatchShortcut({ ctrlKey: true });

      if (originalPlatformDescriptor) {
        Object.defineProperty(
          window.navigator,
          "platform",
          originalPlatformDescriptor,
        );
      }

      return {
        linuxCtrlAWasNotPrevented,
        macCtrlAWasNotPrevented,
        macMetaAWasNotPrevented,
      };
    });

    expect(shortcutResults.macCtrlAWasNotPrevented).toBe(true);
    expect(shortcutResults.macMetaAWasNotPrevented).toBe(false);
    expect(shortcutResults.linuxCtrlAWasNotPrevented).toBe(false);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad skill autocomplete stays inside a small window and scrolls", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
    windowSize: {
      width: 760,
      height: 520,
    },
  });

  try {
    await openDirectoryLaunchpad(app);

    await app.window.getByRole("textbox", { name: "New thread" }).fill("$");

    const listbox = app.window.getByRole("listbox", { name: "Skills" });
    await expect(listbox).toBeVisible();

    const [listboxBox, viewport, scrollMetrics] = await Promise.all([
      listbox.boundingBox(),
      app.window.evaluate(() => ({
        height: globalThis.innerHeight,
        width: globalThis.innerWidth,
      })),
      listbox.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
    ]);
    if (!listboxBox) {
      throw new Error("Expected autocomplete listbox to be measurable");
    }

    expect(listboxBox.x).toBeGreaterThanOrEqual(0);
    expect(listboxBox.y).toBeGreaterThanOrEqual(0);
    expect(listboxBox.x + listboxBox.width).toBeLessThanOrEqual(viewport.width);
    expect(listboxBox.y + listboxBox.height).toBeLessThanOrEqual(viewport.height);
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad parks the composer at the bottom for skill autocomplete space", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({    fixturePath: fixture.fixturePath,
    windowSize: {
      width: 1000,
      height: 820,
    },
  });

  try {
    await openDirectoryLaunchpad(app);

    const composerSlot = app.window.locator(".thread-view__launchpad-composer");
    const { root: richInput, textbox } = getLaunchpadComposer(app);
    const [composerBox, viewport] = await Promise.all([
      composerSlot.boundingBox(),
      app.window.evaluate(() => ({
        height: globalThis.innerHeight,
        width: globalThis.innerWidth,
      })),
    ]);
    if (!composerBox) {
      throw new Error("Expected launchpad composer slot to be measurable");
    }
    expect(composerBox.y + composerBox.height).toBeGreaterThan(viewport.height - 80);

    await textbox.fill("$");
    const listbox = app.window.getByRole("listbox", { name: "Skills" });
    await expect(listbox).toBeVisible();

    const [listboxBox, richInputBox] = await Promise.all([
      listbox.boundingBox(),
      richInput.boundingBox(),
    ]);
    if (!listboxBox || !richInputBox) {
      throw new Error("Expected autocomplete and composer input to be measurable");
    }

    expect(listboxBox.y).toBeGreaterThanOrEqual(0);
    expect(listboxBox.x + listboxBox.width).toBeLessThanOrEqual(viewport.width);
    expect(listboxBox.y + listboxBox.height).toBeLessThanOrEqual(richInputBox.y);
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
