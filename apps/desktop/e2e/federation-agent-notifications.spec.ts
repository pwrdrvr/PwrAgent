import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "./fixtures/electron-test";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { generateFederationIdentityKeyPair } from "../src/main/federation/federation-identity";
import { generateFederationNoiseStaticKeyPair } from "../src/main/federation/federation-noise";
import { launchElectronApp } from "./fixtures/electron-app";

const OWNER_LABEL = "Fixture notice owner";
const SOURCE = "notice-source";
const TURN = "turn-notice-1";

function thread(id: string, title: string, updatedAt: number) {
  return {
    id, title, titleSource: "explicit", source: "codex", executionMode: "default",
    linkedDirectories: [], inbox: { inInbox: true }, updatedAt,
  };
}

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

function fixture(threads: ReturnType<typeof thread>[], steps: ReplayFixture["steps"] = []): ReplayFixture {
  return {
    metadata: { backend: "codex", scenario: "federation-agent-notifications" },
    steps: [
      { id: "initialize", kind: "response", method: "initialize", result: {
        serverInfo: { name: "Replay Codex", version: "1.0.0" }, methods: ["thread/list"],
      } },
      { id: "threads", kind: "response", method: "thread/list", result: threads },
      { id: "read", kind: "response", method: "thread/read", result: {
        entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
      } },
      ...steps,
    ],
  };
}

async function setFederationIdentity(page: Page, restartMode?: "gateway"): Promise<void> {
  await page.evaluate(async ({ identityPrivateKeyPem, noiseStaticPrivateKeyBase64, restartMode }) => {
    const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
    await api.replaceSettingsSecret!({ secret: "federationInstancePrivateKey", value: identityPrivateKeyPem });
    await api.replaceSettingsSecret!({ secret: "federationNoiseStaticPrivateKey", value: noiseStaticPrivateKeyBase64 });
    if (restartMode) {
      await api.writeSettingsConfig!({ patch: { federation: { mode: "disabled" } } });
      await api.writeSettingsConfig!({ patch: { federation: { mode: restartMode } } });
    }
  }, {
    identityPrivateKeyPem: generateFederationIdentityKeyPair().privateKeyPem,
    noiseStaticPrivateKeyBase64: generateFederationNoiseStaticKeyPair().privateKeyBase64,
    restartMode,
  });
}

async function federationHealth(page: Page) {
  return await page.evaluate(async () =>
    (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health);
}

test("a peer's agent notice reaches a connected machine, and dismissing it there clears it on the owner", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-federated-notice-"));
  let owner: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  let viewer: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const ownerFixturePath = path.join(root, "owner.fixture.json");
    await writeFile(ownerFixturePath, JSON.stringify(fixture([thread(SOURCE, "Release notes draft", 1_760_000_000_100)], [
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
    ])));
    const viewerFixturePath = path.join(root, "viewer.fixture.json");
    await writeFile(viewerFixturePath, JSON.stringify(fixture([thread("viewer-local", "Router cleanup before the 2.4 cut", 1_760_000_000_200)])));

    owner = await launchElectronApp({
      fixturePath: ownerFixturePath,
      secretStorage: "memory",
      windowSize: { width: 1280, height: 860 },
      preLaunchHook: async (homeRoot) => {
        const profile = path.join(homeRoot, ".pwragent", "profiles", "default");
        await mkdir(profile, { recursive: true });
        await writeFile(path.join(profile, "config.toml"), [
          "[federation]",
          'mode = "gateway"',
          `instance_label = "${OWNER_LABEL}"`,
          'listen_host = "127.0.0.1"',
          "listen_port = 0",
          "",
        ].join("\n"));
      },
    });
    await setFederationIdentity(owner.window, "gateway");
    await expect.poll(() => federationHealth(owner!.window), { timeout: 30_000 })
      .toMatchObject({ status: "listening" });
    const invite = await owner.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.generateFederationInvite!()).invite);

    viewer = await launchElectronApp({
      fixturePath: viewerFixturePath,
      secretStorage: "memory",
      windowSize: { width: 1280, height: 860 },
    });
    await setFederationIdentity(viewer.window);
    await viewer.window.evaluate(async (encoded) => {
      await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encoded });
    }, invite);
    await expect.poll(() => federationHealth(viewer!.window), { timeout: 30_000 })
      .toMatchObject({ status: "connected" });

    const page = viewer.window;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("region", { name: "Thread browser" })
      .getByRole("button", { name: "Router cleanup before the 2.4 cut", exact: true }).click();
    await expect(page.getByTestId("agent-notifications-button")).toHaveCount(0);

    // An agent on the owner sends a notice.
    await owner.advance({ stepId: "started" });
    await owner.advance({ stepId: "notice-now" });
    const ownerNotice = owner.window.locator(".app-notice-toast").filter({ hasText: "Review the 2.4 changelog" });
    await expect(ownerNotice).toBeVisible();

    // The connected machine shows it while its own thread stays open. The
    // card's thread chip shows the thread's live title once this machine
    // knows the peer's thread, so only the list below names the owner.
    const notice = page.locator(".app-notice-toast").filter({ hasText: "Review the 2.4 changelog" });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText("the changelog draft is ready");
    await expect(notice).toContainText("Release notes draft");
    const bell = page.getByTestId("agent-notifications-button").first();
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread");
    await page.screenshot({ path: testInfo.outputPath("federated-notice-viewer.png") });

    // A scheduled notice on the owner is listed on the viewer, and cancelling it there cancels it on the owner.
    await owner.advance({ stepId: "notice-later" });
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread, 1 scheduled", { timeout: 15_000 });
    await bell.click();
    const popover = page.getByTestId("agent-notifications-popover");
    await expect(popover.getByRole("region", { name: "Unread" })).toContainText(`Release notes draft on ${OWNER_LABEL}`);
    await expect(popover.getByRole("region", { name: "Scheduled" })).toContainText(`Release notes draft on ${OWNER_LABEL}`);
    await page.screenshot({ path: testInfo.outputPath("federated-notice-viewer-list.png") });
    await popover.getByRole("button", { name: "Cancel Check the nightly benchmark", exact: true }).click();
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread");
    const ownerBell = owner.window.getByTestId("agent-notifications-button").first();
    await expect(ownerBell).toHaveAccessibleName("Notifications, 1 unread", { timeout: 15_000 });
    await page.keyboard.press("Escape");

    // Dismissing it on the viewer dismisses it on the owner, so it leaves every window.
    await notice.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(ownerNotice).toHaveCount(0, { timeout: 15_000 });
    await expect(owner.window.getByTestId("agent-notifications-button")).toHaveCount(0);
    await expect(page.getByTestId("agent-notifications-button")).toHaveCount(0);
  } finally {
    try {
      await viewer?.close();
      await owner?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
