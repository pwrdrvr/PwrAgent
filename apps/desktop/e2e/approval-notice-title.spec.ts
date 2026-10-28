import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

test("names an approval outside the loaded page and updates it on rename", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-approval-title-"));
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const waitingThread: AppServerThreadSummary = {
      id: "off-page-approval", title: "Warm CI dependencies", titleSource: "explicit",
      source: "codex", executionMode: "default", linkedDirectories: [],
      inbox: { inInbox: true }, updatedAt: 1_760_000_000_000,
    };
    const fixture: ReplayFixture = {
      metadata: { backend: "codex", scenario: "approval-notice-title" },
      steps: [
        { id: "initialize", kind: "response", method: "initialize", result: {
          serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list"],
        } },
        { id: "threads", kind: "response", method: "thread/list", result: [
          ...Array.from({ length: 100 }, (_, index) => ({
            ...waitingThread, id: `recent-${index}`, title: `Recent fixture ${index}`,
            updatedAt: waitingThread.updatedAt + 100 - index,
          })),
          waitingThread,
        ] },
        { id: "approval", kind: "request", request: {
          method: "mcpServer/elicitation/request", params: {
            threadId: waitingThread.id, requestId: "approval-1", serverName: "GitHub",
            mode: "form", message: "Allow the agent to open a pull request on GitHub?",
            _meta: { codex_approval_kind: "mcp_tool_call" },
            requestedSchema: { type: "object", properties: {} },
          },
        } },
      ],
    };
    const fixturePath = path.join(root, "replay.fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    const app = await launchElectronApp({ fixturePath });
    closeApp = app.close;
    const waitingRow = app.window.locator('.thread-row-shell[data-thread-key="codex:off-page-approval"]');
    await expect(app.window.locator(".thread-row-shell").first()).toBeVisible();
    await expect(waitingRow).toHaveCount(0);
    await app.advance({ stepId: "approval" });
    const notice = app.window.locator(".app-notice-toast").filter({ hasText: "Tool approval needed" });
    await expect(notice.getByRole("button", { name: "Open thread Warm CI dependencies", exact: true })).toBeVisible();
    await notice.screenshot({ path: testInfo.outputPath("approval-title.png") });

    await app.window.evaluate(async () => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.renameThread!({ backend: "codex", threadId: "off-page-approval", name: "Fix CI install hangs" });
    });
    await expect(notice.getByRole("button", { name: "Open thread Fix CI install hangs", exact: true })).toBeVisible();
    await expect(waitingRow).toHaveCount(0);
    await notice.screenshot({ path: testInfo.outputPath("approval-title-renamed.png") });
  } finally {
    try { await closeApp?.(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
