import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-test";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { launchElectronApp } from "./fixtures/electron-app";

const SOURCE = "notice-source";
const FOCUSED = "notice-focused";
const TURN = "turn-notice-1";

function notifyCall(id: string, args: Record<string, unknown>) {
  return {
    id,
    kind: "request" as const,
    request: {
      method: "item/tool/call",
      params: {
        threadId: SOURCE, turnId: TURN, callId: `call-${id}`, requestId: `request-${id}`,
        namespace: "pwragent", tool: "notify_operator", arguments: args,
      },
    },
  } as unknown as ReplayFixture["steps"][number];
}

test("an agent's notice reaches the operator while another thread is focused", async ({ browserName: _browserName }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-agent-notice-"));
  let closeApp: (() => Promise<void>) | undefined;
  try {
    const thread = (id: string, title: string, updatedAt: number) => ({
      id, title, titleSource: "explicit", source: "codex", executionMode: "default",
      linkedDirectories: [], inbox: { inInbox: true }, updatedAt,
    });
    const emptyRead = { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } };
    const fixture: ReplayFixture = {
      metadata: { backend: "codex", scenario: "agent-notification-toast" },
      steps: [
        { id: "initialize", kind: "response", method: "initialize", result: {
          serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list"],
        } },
        { id: "threads", kind: "response", method: "thread/list", result: [
          thread(FOCUSED, "Router cleanup before the 2.4 cut", 1_760_000_000_200),
          thread(SOURCE, "Release notes draft", 1_760_000_000_100),
        ] },
        { id: "read", kind: "response", method: "thread/read", result: emptyRead },
        { id: "started", kind: "notification", notification: {
          method: "turn/started", params: { threadId: SOURCE, turn: { id: TURN, status: "inProgress" } },
        } },
        notifyCall("notice-now", {
          action: "send",
          title: "Review the 2.4 changelog",
          body: "You asked me to remind you: the changelog draft is ready for a read before the cut.",
        }),
        notifyCall("notice-later", {
          action: "send",
          title: "Check the nightly benchmark",
          body: "The nightly benchmark finishes around six. Compare it with last week's run.",
          delayMinutes: 120,
        }),
      ],
    };
    const fixturePath = path.join(root, "replay.fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    const app = await launchElectronApp({ fixturePath, windowSize: { width: 1280, height: 860 } });
    closeApp = app.close;
    const { window } = app;

    await window.locator(`.thread-row-shell[data-thread-key="codex:${FOCUSED}"]`).first().click();
    await expect(window.getByRole("heading", { level: 2, name: "Router cleanup before the 2.4 cut" })).toBeVisible();
    // No notice yet: the bell is not in the window.
    await expect(window.getByTestId("agent-notifications-button")).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath("agent-notice-before.png") });

    await app.advance({ stepId: "started" });
    await app.advance({ stepId: "notice-now" });

    const notice = window.locator(".app-notice-toast").filter({ hasText: "Review the 2.4 changelog" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("the changelog draft is ready");
    // The operator is still on the other thread.
    await expect(window.getByRole("heading", { level: 2, name: "Router cleanup before the 2.4 cut" })).toBeVisible();
    const bell = window.getByTestId("agent-notifications-button").first();
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread");
    await notice.screenshot({ path: testInfo.outputPath("agent-notice-toast.png") });

    await app.advance({ stepId: "notice-later" });
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread, 1 scheduled");
    await bell.click();
    const popover = window.getByTestId("agent-notifications-popover");
    // The list is a portal, so opening it moves keyboard focus into it.
    await expect(popover).toBeFocused();
    await expect(popover.getByRole("region", { name: "Unread" })).toContainText("Review the 2.4 changelog");
    const scheduled = popover.getByRole("region", { name: "Scheduled" });
    await expect(scheduled).toContainText("Check the nightly benchmark");
    await window.screenshot({ path: testInfo.outputPath("agent-notice-window.png") });
    await scheduled.getByRole("button", { name: "Cancel Check the nightly benchmark", exact: true }).click();
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread");
    await window.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);

    await notice.getByRole("button", { name: "Open thread", exact: true }).click();
    await expect(window.getByRole("heading", { level: 2, name: "Release notes draft" })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(window.getByTestId("agent-notifications-button")).toHaveCount(0);
  } finally {
    try { await closeApp?.(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
