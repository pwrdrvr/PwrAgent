import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test, type Page } from "./fixtures/electron-test";

const projectCount = 42;
const projectName = (index: number) => `Project ${String(index).padStart(2, "0")}`;

async function writeReplay(root: string): Promise<string> {
  const threads = await Promise.all(Array.from({ length: projectCount }, async (_, index) => {
    const name = projectName(index);
    const directory = path.join(root, name);
    await mkdir(directory);
    return {
      id: `project-index-${index}`,
      title: `${name} thread`,
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      createdAt: 1760000000000 - index,
      updatedAt: 1760000000000 - index,
      linkedDirectories: [{ id: `repo-${index}`, kind: "local", label: name, path: directory }],
    };
  }));
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "project-index-scroll", threadId: threads[0]!.id },
    steps: [
      {
        id: "initialize-1",
        kind: "response",
        method: "initialize",
        result: { serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read"] },
      },
      { id: "thread-list-1", kind: "response", method: "thread/list", result: threads },
      ...threads.map(({ id }) => ({
        id: `read-${id}`, kind: "response", method: "thread/read", threadId: id,
        result: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } },
      })),
    ],
  }));
  return fixturePath;
}

async function expectIndexMatchesViewport(page: Page, reactionPresent?: boolean): Promise<void> {
  await expect.poll(() => page.evaluate((expectedReaction) => {
    const list = document.querySelector<HTMLElement>(".sidebar__scroll-region > .directory-list")!;
    const nav = document.querySelector<HTMLElement>("nav.project-index")!;
    if (expectedReaction !== undefined) {
      const row = list.querySelector('[data-thread-key="codex:project-index-0"]');
      const reaction = row?.querySelector('[aria-label="Remove reaction 👀 from thread"]');
      if (!row || Boolean(reaction) !== expectedReaction) return "waiting for rendered reaction";
    }
    const top = list.getBoundingClientRect().top;
    const bottom = top + list.clientHeight;
    const region = list.parentElement!;
    const reserve = region.classList.contains("has-selected-thread-dock-top")
      ? parseFloat(getComputedStyle(region).getPropertyValue("--selected-thread-dock-reserve"))
      : 0;
    const expected = [...list.querySelectorAll(":scope > section[data-directory-key]")].flatMap((section) => {
      const { top: start, bottom: end } = section.getBoundingClientRect();
      return end > top + reserve + 1 && start < bottom
        ? [section.getAttribute("data-directory-key")!] : [];
    });
    const current = nav.querySelector("[aria-current=location]")?.getAttribute("data-project-key");
    const visible = Array.from(nav.querySelectorAll(".is-current, .is-in-view"), (item) =>
      item.getAttribute("data-project-key")!).sort();
    if (expected.length > 0 && current === expected[0] && JSON.stringify(visible) === JSON.stringify(expected.sort())) {
      return "matched";
    }
    return { expected, current, visible, reserve };
  }, reactionPresent)).toBe("matched");
}

test("Project Index tracks live directory geometry during navigation and scroll", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-project-index-"));
  try {
    const app = await launchElectronApp({
      fixturePath: await writeReplay(root),
      windowSize: { width: 1280, height: 720 },
    });
    try {
      const page = app.window;
      const browser = page.getByRole("region", { name: "Thread browser" });
      const index = browser.getByRole("navigation", { name: "Project index" });
      const projects = browser.locator(".directory-list");
      const directories = browser.getByRole("tab", { name: "Directories", exact: true });
      await expect(page.getByRole("button", { name: /^Show Project 00 in Directories$/ })).toBeVisible();
      await directories.click();
      await expect(index.getByRole("button", { name: /^Jump to Project / })).toHaveCount(projectCount);
      await expectIndexMatchesViewport(page);

      const startupProject = projects.getByRole("button", { name: projectName(0), exact: true });
      await expect(startupProject).toHaveAttribute("aria-expanded", "true");
      // An owner pin moves a late project above the currently open section and adds a divider.
      await projects.getByRole("button", { name: projectName(4), exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Pin Directory", exact: true }).click();
      await expect(projects.locator(".directory-row").first()).toContainText(projectName(4));
      await expectIndexMatchesViewport(page);

      // Reactions use the owner navigation update path while scroll crosses sections.
      for (const [step, offset] of [235, 476, 620, 289].entries()) {
        const present = step % 2 === 0;
        await projects.evaluate(async (list, { offset, present }) => {
          const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
          list.scrollTop = offset;
          await api.setThreadReaction!({
            backend: "codex", threadId: "project-index-0", emoji: "👀", present,
          });
        }, { offset, present });
        // Owner acknowledgement can precede the renderer's reaction update.
        await expectIndexMatchesViewport(page, present);
      }

      await expect(browser.locator(".sidebar__scroll-region")).toHaveClass(/has-selected-thread-dock-top/);
      const tabStop = index.locator("button[data-project-key][tabindex='0']");
      await expect(tabStop).toHaveCount(1);
      await tabStop.focus();
      await page.keyboard.press("End");
      const last = index.getByRole("button", { name: /^Jump to Project 41/ });
      await expect(last).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(last).toHaveAttribute("aria-current", "location");
      await expect(last).toBeFocused();
      await expectIndexMatchesViewport(page);

      await browser.getByRole("tab", { name: "Updated", exact: true }).click();
      await expect(projects).toHaveCount(0);
      await expect(index.locator("[aria-current=location]")).toHaveCount(0);
      await directories.click();
      await expect(projects).toHaveCount(1);
      await expectIndexMatchesViewport(page);
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
