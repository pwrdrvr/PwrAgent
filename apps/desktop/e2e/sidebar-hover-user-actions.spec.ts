import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const PROJECTS = ["Aproject", "Bproject", "Cproject"] as const;

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-hover-actions-"));
  const fixturePath = path.join(rootDir, "sidebar-hover-user-actions.fixture.json");
  const threads = [];
  for (const [index, project] of PROJECTS.entries()) {
    const repoDir = path.join(rootDir, project);
    await mkdir(repoDir, { recursive: true });
    const linkedDirectories = [{ id: `${project}-repo`, kind: "local", label: project, path: repoDir }];
    for (const n of [1, 2]) {
      threads.push({
        id: `thread-${project}-${n}`,
        title: `${project} thread ${n}`,
        titleSource: "explicit",
        summary: "Hover action fixture.",
        source: "codex",
        executionMode: "default",
        linkedDirectories,
        createdAt: 2_000 - index * 10 - n,
        updatedAt: 2_000 - index * 10 - n,
      });
    }
  }
  const read = (id: string) => ({
    id: `read-${id}`,
    kind: "response",
    method: "thread/read",
    result: {
      entries: [{ type: "message", id: `${id}-m`, role: "assistant", text: "Hover action fixture." }],
      messages: [{ id: `${id}-m`, role: "assistant", text: "Hover action fixture." }],
      lastAssistantMessage: "Hover action fixture.",
      pagination: { supportsPagination: false, hasPreviousPage: false },
    },
  });
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "sidebar-hover-user-actions", threadId: threads[0]!.id },
    steps: [
      {
        id: "initialize-1",
        kind: "response",
        method: "initialize",
        result: { serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read"] },
      },
      { id: "thread-list-1", kind: "response", method: "thread/list", result: threads },
      ...threads.map((thread) => read(thread.id)),
    ],
  }, null, 2), "utf8");
  return { cleanup: () => rm(rootDir, { force: true, recursive: true }), fixturePath };
}

function directoryRow(page: Page, label: string): Locator {
  return page.locator(".directory-row").filter({
    has: page.getByRole("button", { name: label, exact: true }),
  });
}

/** Directory and thread rows in rendered order; `*` marks a pin. */
async function sidebarLayout(page: Page): Promise<string[]> {
  return page.locator(".directory-row, .thread-row-shell").evaluateAll((rows) => rows.map((row) => {
    if (row.classList.contains("directory-row")) {
      const label = row.querySelector(".directory-row__title")?.textContent?.trim() ?? "";
      return `[${label}]${row.getAttribute("data-directory-pinned") === "true" ? "*" : ""}`;
    }
    const title = row.querySelector(".thread-row__title")?.textContent?.trim() ?? "";
    return `${title}${row.querySelector('[data-thread-pin-state="pinned"]') ? "*" : ""}`;
  }));
}

/**
 * Choose a directory's menu item the way a mouse does: the pointer leaves the
 * rows for the menu, then rests on `restOn` once the menu closes over them.
 */
async function chooseDirectoryMenuItem(page: Page, label: string, item: string, restOn: Locator): Promise<void> {
  await page.getByRole("button", { name: label, exact: true })
    .click({ button: "right", position: { x: 12, y: 8 } });
  await page.getByRole("menuitem", { name: item }).click();
  const box = await restOn.boundingBox();
  if (!box) throw new Error("Expected a row for the pointer to rest on");
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.move(box.x + 41, box.y + box.height / 2);
}

async function movePointerOffSidebar(page: Page): Promise<void> {
  await page.mouse.move(1000, 400);
}

/**
 * Background list churn: every toggle of a reaction on another thread
 * invalidates and re-reads each navigation page, as live turns do.
 */
async function startChurn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as {
      pwragent: { setThreadReaction: (request: unknown) => Promise<unknown> };
    }).pwragent;
    let present = true;
    (window as unknown as { __sidebarChurn: number }).__sidebarChurn = window.setInterval(() => {
      void api.setThreadReaction({ backend: "codex", threadId: "thread-Aproject-2", emoji: "👀", present });
      present = !present;
    }, 40);
  });
}

async function stopChurn(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.clearInterval((window as unknown as { __sidebarChurn: number }).__sidebarChurn);
  });
}

test.describe("sidebar commands under a resting pointer", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let app: Awaited<ReturnType<typeof launchElectronApp>>;

  test.beforeEach(async () => {
    fixture = await createFixture();
    app = await launchElectronApp({ fixturePath: fixture.fixturePath, windowSize: { width: 1280, height: 900 } });
    await app.window.getByRole("region", { name: "Thread browser" })
      .getByRole("tab", { name: "Directories" }).click();
    await expect(directoryRow(app.window, "Cproject")).toBeVisible();
  });

  test.afterEach(async () => {
    await app?.close();
    await fixture?.cleanup();
  });

  test("a directory pin and unpin show before the pointer leaves", async () => {
    const page = app.window;
    const restOn = page.getByRole("button", { name: "Aproject", exact: true });
    await chooseDirectoryMenuItem(page, "Cproject", "Pin Directory", restOn);
    await expect.poll(() => sidebarLayout(page)).toEqual(["[Cproject]*", "[Aproject]", "[Bproject]"]);

    await chooseDirectoryMenuItem(page, "Cproject", "Unpin Directory", restOn);
    await expect.poll(() => sidebarLayout(page)).toEqual(["[Aproject]", "[Bproject]", "[Cproject]"]);
    await movePointerOffSidebar(page);
    await expect.poll(() => sidebarLayout(page)).toEqual(["[Aproject]", "[Bproject]", "[Cproject]"]);
  });

  test("unpinning the selected thread's directory shows under background churn", async () => {
    const page = app.window;
    const restOn = page.getByRole("button", { name: "Bproject", exact: true });
    await chooseDirectoryMenuItem(page, "Bproject", "Pin Directory", restOn);
    await chooseDirectoryMenuItem(page, "Cproject", "Pin Directory", restOn);
    await page.getByRole("button", { name: "Cproject", exact: true }).click();
    await page.getByRole("button", { name: /^Cproject thread 1/ }).click();
    await startChurn(page);
    try {
      // The race this guards is timing-dependent; each round is a fresh try.
      for (let round = 0; round < 3; round += 1) {
        await movePointerOffSidebar(page);
        await expect.poll(() => sidebarLayout(page)).toEqual([
          "[Bproject]*", "[Cproject]*", "Cproject thread 1", "Cproject thread 2", "[Aproject]",
        ]);
        await chooseDirectoryMenuItem(page, "Cproject", "Unpin Directory", restOn);
        await expect.poll(() => sidebarLayout(page)).toEqual([
          "[Bproject]*", "[Aproject]", "[Cproject]", "Cproject thread 1", "Cproject thread 2",
        ]);
        await movePointerOffSidebar(page);
        await chooseDirectoryMenuItem(page, "Cproject", "Pin Directory", restOn);
      }
    } finally {
      await stopChurn(page);
    }
  });
});
