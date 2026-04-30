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
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function openDirectoryLaunchpad(app: Awaited<ReturnType<typeof launchElectronApp>>) {
  await app.window.getByRole("button", { name: "directories" }).click();
  await app.window
    .getByRole("button", { name: "Open new thread launchpad for FixtureRepo" })
    .click();

  await expect(
    app.window.getByRole("heading", { level: 2, name: "FixtureRepo" }),
  ).toBeVisible();
}

test("directory launchpad loads skill autocomplete from user and local scope", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
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

test("directory launchpad skill autocomplete selects focused options as undoable inline chips", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
  });

  try {
    await openDirectoryLaunchpad(app);

    const textbox = app.window.getByRole("textbox", { name: "New thread" });
    await textbox.fill("$front");

    const option = app.window.getByRole("button", { name: /\$frontend-design/i });
    await option.focus();
    await expect(option).toBeFocused();
    await app.window.keyboard.press("Enter");

    await expect(app.window.getByRole("listbox", { name: "Skills" })).toBeHidden();

    const richInput = app.window.getByTestId("composer-rich-input");
    const chip = richInput.locator(".skill-chip", { hasText: "$frontend-design" });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute(
      "data-tooltip",
      /\/Users\/huntharo\/\.codex\/skills\/frontend-design\/SKILL\.md$/,
    );

    const [chipBox, inputBox] = await Promise.all([
      chip.boundingBox(),
      richInput.boundingBox(),
    ]);
    if (!chipBox || !inputBox) {
      throw new Error("Expected selected skill chip and composer input to be measurable");
    }
    expect(chipBox.y).toBeGreaterThanOrEqual(inputBox.y);
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(
      inputBox.y + inputBox.height,
    );

    await richInput.focus();
    await app.window.keyboard.press("Backspace");
    await expect(chip).toBeHidden();

    await richInput.focus();
    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z",
    );
    await expect(chip).toBeVisible();

    await chip.click();
    await expect(chip).toBeFocused();
    await app.window.keyboard.press("Backspace");
    await expect(chip).toBeHidden();

    await app.window.keyboard.press(
      process.platform === "darwin" ? "Meta+Z" : "Control+Z",
    );
    await expect(chip).toBeVisible();

    await app.window.waitForTimeout(300);
    await app.window
      .getByRole("button", { name: /Directory launchpad replay/i })
      .first()
      .click();
    await openDirectoryLaunchpad(app);

    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toBeFocused();
    await app.window.keyboard.press("Backspace");
    await expect(chip).toBeHidden();
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});

test("directory launchpad skill autocomplete stays inside a small window and scrolls", async () => {
  const fixture = await createDirectoryLaunchpadSkillsFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
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
