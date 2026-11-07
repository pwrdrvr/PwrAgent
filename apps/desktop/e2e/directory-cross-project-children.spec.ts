import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";

test("keeps a peer parent's cross-project audit in its own directory", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-project-grouping-"));
  const gitPath = path.join(root, "HarborGit");
  const diskPath = path.join(root, "DiskTree");
  await Promise.all([mkdir(gitPath), mkdir(diskPath)]);
  const directory = (projectPath: string) => ({ id: projectPath, path: projectPath, label: path.basename(projectPath), kind: "local" as const });
  const threads = [
    { id: "storage-audit", title: "Storage property tests", linkedDirectories: [directory(diskPath)] },
    { id: "storage-fix", title: "Preserve scanned bytes", linkedDirectories: [directory(diskPath)] },
    { id: "git-local", title: "Git housekeeping", linkedDirectories: [directory(gitPath)] },
    { id: "git-child", title: "Check repository state", linkedDirectories: [directory(gitPath)] },
    { id: "git-grandchild", title: "Verify branch tracking", linkedDirectories: [directory(gitPath)] },
  ].map((thread, index) => ({ ...thread, titleSource: "explicit", source: "codex", executionMode: "default", updatedAt: 1000 - index }));
  const fixturePath = path.join(root, "project-grouping.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "directory-project-grouping", threadId: "storage-audit" },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list", "thread/read"],
      } },
      { id: "list", kind: "response", method: "thread/list", result: threads },
      ...threads.map((thread) => ({ id: `read-${thread.id}`, kind: "response", method: "thread/read", threadId: thread.id,
        result: { entries: [{ type: "message", id: `message-${thread.id}`, role: "assistant", text: "Fixture audit complete. The property tests pass." }],
          messages: [{ id: `message-${thread.id}`, role: "assistant", text: "Fixture audit complete. The property tests pass." }],
          pagination: { supportsPagination: false, hasPreviousPage: false } },
      })),
    ],
  }, null, 2));

  const ref = buildFederatedThreadRef({ backend: "codex", instanceId: "fixture-peer", threadId: "git-audit" });
  const app = await launchElectronApp({ fixturePath, windowSize: { width: 1440, height: 900 }, appearance: { theme: "light" },
    preLaunchHook: async (homeRoot) => {
      const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
      try {
        const overlay = new SqliteOverlayStore(stateDb);
        await overlay.addRemoteThreadPin({ ref, instanceLabel: "Fixture Mac", summary: {
          id: "git-audit", source: "codex", title: "Repository property tests", titleSource: "explicit",
          linkedDirectories: [directory(gitPath)], inbox: { inInbox: false },
        } });
        await overlay.setRemoteThreadLocalPin({ ref, pinned: true });
        await overlay.setThreadParent({ backend: "codex", threadId: "storage-audit",
          parentThreadId: "git-audit", parentThreadBackend: "codex", parentThreadInstanceId: "fixture-peer" });
        await overlay.setThreadParent({ backend: "codex", threadId: "storage-fix",
          parentThreadId: "storage-audit", parentThreadBackend: "codex" });
        await overlay.setThreadPin({ backend: "codex", threadId: "storage-audit", pinnedRank: "1024" });
        await overlay.setThreadParent({ backend: "codex", threadId: "git-child",
          parentThreadId: "git-local", parentThreadBackend: "codex" });
        await overlay.setThreadParent({ backend: "codex", threadId: "git-grandchild",
          parentThreadId: "git-child", parentThreadBackend: "codex" });
      } finally {
        stateDb.close();
      }
    },
  });
  try {
    await app.window.getByRole("button", { name: /^Storage property tests/ }).click();
    await expect(app.window.getByRole("heading", { level: 2, name: "Storage property tests" })).toBeVisible();
    await app.window.getByRole("tab", { name: "directories" }).click();
    const git = app.window.getByRole("button", { name: /^HarborGit(,|$)/ });
    const disk = app.window.getByRole("button", { name: /^DiskTree(,|$)/ });
    for (const project of [git, disk]) {
      if (await project.getAttribute("aria-expanded") !== "true") await project.click();
    }
    // The collapsed population includes descendants whose child pages have
    // never been opened, while the mounted peer pin stays above the divider.
    const hideDirectoryThreads = app.window.getByRole("button", { name: "Hide directory threads for HarborGit", exact: true });
    await expect(hideDirectoryThreads).toBeVisible();
    await hideDirectoryThreads.click();
    const showDirectoryThreads = app.window.getByRole("button", { name: "Show directory threads for HarborGit", exact: true });
    await expect(app.window.getByRole("button", { name: /^Repository property tests/ })).toBeVisible();
    await expect(app.window.getByRole("button", { name: /^Preserve scanned bytes/ }).first()).toBeVisible();
    await app.window.evaluate(async () => { await document.fonts.ready; });
    const browserBounds = await app.window.getByRole("region", { name: "Thread browser" }).boundingBox();
    if (!browserBounds) throw new Error("The directory browser has no layout.");
    await app.window.screenshot({ path: testInfo.outputPath("directory-project-grouping.png"),
      clip: { ...browserBounds, height: Math.min(browserBounds.height, 500) } });
    await expect(showDirectoryThreads).toContainText("3");
    const audit = app.window.getByRole("button", { name: /^Storage property tests/ });
    await expect(audit).toHaveCount(1);
    await expect(app.window.getByRole("button", { name: /^Preserve scanned bytes/ })).toHaveCount(1);
    await expect(audit.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' directory-row ')][1]"))
      .toContainText("DiskTree");
    await audit.click();
    await expect(app.window.getByRole("heading", { level: 2, name: "Storage property tests" })).toBeVisible();
    await expect(audit).toHaveCount(1);
    // Global grouping still carries the cross-project relationship.
    await app.window.getByRole("tab", { name: "Created" }).click();
    await expect(app.window.getByLabel("Sub-threads of Repository property tests").getByRole("button", { name: /^Storage property tests/ })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
