import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import { StateDb } from "../src/main/state/state-db";

async function createThreadTitleRevealFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-thread-reveal-"));
  const repoDir = path.join(rootDir, "RevealFixture");
  const fixturePath = path.join(rootDir, "thread-title-reveal.fixture.json");
  await mkdir(repoDir, { recursive: true });

  const linkedDirectories = [
    {
      id: "reveal-fixture-repo",
      kind: "local",
      label: "RevealFixture",
      path: repoDir,
    },
  ];
  const fillerThreads = Array.from({ length: 8 }, (_, index) => ({
    id: `thread-filler-${index + 1}`,
    title: `Filler thread ${index + 1}`,
    titleSource: "explicit",
    summary: "Makes the selected child require a real sidebar scroll.",
    source: "codex",
    executionMode: "default",
    linkedDirectories,
    createdAt: 1_800 - index,
    updatedAt: 1_800 - index,
  }));

  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "thread-title-reveal",
          threadId: "thread-parent",
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
              methods: ["thread/list", "thread/read"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-anchor",
                title: "Pinned anchor thread",
                titleSource: "explicit",
                summary: "Keeps the directory disclosure available.",
                source: "codex",
                executionMode: "default",
                linkedDirectories,
                createdAt: 2_000,
                updatedAt: 2_000,
              },
              ...fillerThreads,
              {
                id: "thread-parent",
                title: "Parent thread with child link",
                titleSource: "explicit",
                summary: "Links to a child hidden in the directory list.",
                source: "codex",
                executionMode: "default",
                linkedDirectories,
                createdAt: 1_000,
                updatedAt: 1_000,
              },
              {
                id: "thread-child",
                title: "Hidden linked child thread",
                titleSource: "explicit",
                summary: "The row the title reveal must restore.",
                source: "codex",
                executionMode: "default",
                linkedDirectories,
                createdAt: 900,
                updatedAt: 900,
              },
            ],
          },
          {
            id: "thread-read-anchor",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "anchor-message-1",
                  role: "assistant",
                  text: "Pin this thread before exercising the reveal.",
                },
              ],
              messages: [
                {
                  id: "anchor-message-1",
                  role: "assistant",
                  text: "Pin this thread before exercising the reveal.",
                },
              ],
              lastAssistantMessage: "Pin this thread before exercising the reveal.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-read-parent",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "parent-message-1",
                  role: "assistant",
                  text: "Open the [linked child](pwragent://thread/thread-child?backend=codex).",
                },
              ],
              messages: [
                {
                  id: "parent-message-1",
                  role: "assistant",
                  text: "Open the [linked child](pwragent://thread/thread-child?backend=codex).",
                },
              ],
              lastAssistantMessage: "Open the linked child.",
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false,
              },
            },
          },
          {
            id: "thread-read-child",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [
                {
                  type: "message",
                  id: "child-message-1",
                  role: "assistant",
                  text: "The hidden child is focused.",
                },
              ],
              messages: [
                {
                  id: "child-message-1",
                  role: "assistant",
                  text: "The hidden child is focused.",
                },
              ],
              lastAssistantMessage: "The hidden child is focused.",
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
      await rm(rootDir, { force: true, recursive: true });
    },
    fixturePath,
  };
}

test("thread title reveals a linked child hidden by collapsed directory sections", async () => {
  const fixture = await createThreadTitleRevealFixture();
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    windowSize: { width: 1280, height: 760 },
    preLaunchHook: async (homeRoot) => {
      const stateDb = StateDb.open(
        path.join(
          homeRoot,
          ".pwragent",
          "profiles",
          "default",
          "state",
          "state.db",
        ),
        { profileName: "default" },
      );
      try {
        const overlayStore = new SqliteOverlayStore(stateDb);
        await overlayStore.setThreadParent({
          backend: "codex",
          threadId: "thread-child",
          parentThreadId: "thread-parent",
        });
      } finally {
        stateDb.close();
      }
    },
  });

  try {
    const threadBrowser = app.window.getByRole("region", {
      name: "Thread browser",
    });
    const anchorShell = threadBrowser
      .locator(".thread-row-shell")
      .filter({ hasText: "Pinned anchor thread" });
    await anchorShell.hover();
    await anchorShell.getByRole("button", { name: "Open thread actions" }).click();
    await app.window.getByRole("menuitem", { name: "Pin Thread" }).click();

    await threadBrowser
      .getByRole("button", {
        name: "Parent thread with child link",
        exact: true,
      })
      .click();
    const childChip = app.window.getByRole("button", {
      name: "Open thread Hidden linked child thread",
    });
    await expect(childChip).toBeVisible();

    await threadBrowser.getByRole("tab", { name: "Directories" }).click();
    const directorySummary = threadBrowser
      .locator(".directory-row__summary")
      .filter({ hasText: "RevealFixture" });
    await expect(directorySummary).toHaveAttribute("aria-expanded", "true");

    const hideDirectoryThreads = threadBrowser.getByRole("button", {
      name: "Hide directory threads for RevealFixture",
    });
    await expect(hideDirectoryThreads).toBeVisible();
    const collapseSubthreads = threadBrowser.getByRole("button", {
      name: "Collapse sub-threads for Parent thread with child link",
    });
    await collapseSubthreads.click();
    await expect(
      threadBrowser.getByRole("button", {
        name: "Expand sub-threads for Parent thread with child link",
      }),
    ).toBeVisible();
    await hideDirectoryThreads.click();
    await expect(
      threadBrowser.getByRole("button", {
        name: "Show directory threads for RevealFixture",
      }),
    ).toBeVisible();

    await childChip.click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Hidden linked child thread",
      }),
    ).toBeVisible();

    await directorySummary.click();
    await expect(directorySummary).toHaveAttribute("aria-expanded", "false");

    await app.window
      .getByRole("button", { name: "Show selected thread in thread list" })
      .click();

    await expect(directorySummary).toHaveAttribute("aria-expanded", "true");
    await expect(
      threadBrowser.getByRole("button", {
        name: "Hide directory threads for RevealFixture",
      }),
    ).toBeVisible();
    await expect(
      threadBrowser.getByRole("button", {
        name: "Collapse sub-threads for Parent thread with child link",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    const selectedChild = threadBrowser
      .locator(".thread-row.is-selected")
      .filter({ hasText: "Hidden linked child thread" });
    await expect(selectedChild).toBeVisible();

    const scrollRegion = threadBrowser.locator(".sidebar__scroll-region");
    const [childBox, scrollBox] = await Promise.all([
      selectedChild.boundingBox(),
      scrollRegion.boundingBox(),
    ]);
    expect(childBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    expect(childBox!.y).toBeGreaterThanOrEqual(scrollBox!.y);
    expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(
      scrollBox!.y + scrollBox!.height,
    );
  } finally {
    await app.close();
    await fixture.cleanup();
  }
});
