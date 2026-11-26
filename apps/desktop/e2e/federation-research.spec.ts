import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./fixtures/electron-test";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { generateFederationIdentityKeyPair } from "../src/main/federation/federation-identity";
import { generateFederationNoiseStaticKeyPair } from "../src/main/federation/federation-noise";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import {
  LIVE_RESEARCH_OBJECTIVE,
  RESEARCH_FIXTURE_OBJECTIVE,
  enableResearchFixture,
  readResearchOwnerIdentity,
  seedLiveResearchRun,
  seedResearchState,
} from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const baseResearchFixturePath = path.join(specDir, "fixtures/research/replay.fixture.json");
const OWNER_LABEL = "Fixture research owner";
const OWNER_THREAD_ID = "thread-smoke";
const OWNER_THREAD_TITLE = "Remote queue ordering research";
const REMOTE_PIN_TITLE = OWNER_THREAD_TITLE;

async function createResearchReplayFixtureWithTurns(options?: {
  threadTitle?: string;
}): Promise<{ cleanup: () => Promise<void>; fixturePath: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-federation-research-e2e-"));
  const fixturePath = path.join(rootDir, "replay.fixture.json");
  const raw = JSON.parse(await readFile(baseResearchFixturePath, "utf8")) as {
    metadata: Record<string, unknown>;
    steps: Array<{
      id: string;
      kind: string;
      method?: string;
      result?: unknown;
    }>;
  };
  for (const step of raw.steps) {
    if (step.kind === "response" && step.method === "initialize" && step.result && typeof step.result === "object") {
      const result = step.result as { methods?: string[] };
      result.methods = [...new Set([...(result.methods ?? []), "turn/start"])];
    }
    if (step.kind === "response" && step.method === "thread/list" && Array.isArray(step.result) && options?.threadTitle) {
      const smoke = step.result.find((entry) => entry && typeof entry === "object" && (entry as { id?: string }).id === OWNER_THREAD_ID) as
        | { title?: string }
        | undefined;
      if (smoke) smoke.title = options.threadTitle;
    }
  }
  raw.steps.push({
    id: "turn-start-research-1",
    kind: "response",
    method: "turn/start",
    result: {
      threadId: OWNER_THREAD_ID,
      turnId: "research-request-turn-1",
    },
  });
  await writeFile(fixturePath, JSON.stringify(raw, null, 2));
  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    fixturePath,
  };
}

async function restoreE2eFederationIdentity(params: {
  identityPrivateKeyPem: string;
  noiseStaticPrivateKeyBase64: string;
  page: Page;
  restartMode?: "client" | "gateway";
}): Promise<void> {
  await params.page.evaluate(
    async ({ identityPrivateKeyPem, noiseStaticPrivateKeyBase64, restartMode }) => {
      const api = (window as typeof window & {
        pwragent?: {
          replaceSettingsSecret?: (request: { secret: string; value: string }) => Promise<unknown>;
          writeSettingsConfig?: (request: unknown) => Promise<unknown>;
        };
      }).pwragent;
      if (!api?.replaceSettingsSecret || !api.writeSettingsConfig) {
        throw new Error("Federation identity test APIs are unavailable");
      }
      await api.replaceSettingsSecret({
        secret: "federationInstancePrivateKey",
        value: identityPrivateKeyPem,
      });
      await api.replaceSettingsSecret({
        secret: "federationNoiseStaticPrivateKey",
        value: noiseStaticPrivateKeyBase64,
      });
      if (restartMode) {
        await api.writeSettingsConfig({ patch: { federation: { mode: "disabled" } } });
        await api.writeSettingsConfig({ patch: { federation: { mode: restartMode } } });
      }
    },
    {
      identityPrivateKeyPem: params.identityPrivateKeyPem,
      noiseStaticPrivateKeyBase64: params.noiseStaticPrivateKeyBase64,
      restartMode: params.restartMode,
    },
  );
}

test.describe("federation research", () => {
  test("lists, reads, reviews, stops, and starts Research runs on the owning instance without touching a colliding local thread", async () => {
    test.setTimeout(180_000);
    const ownerFixture = await createResearchReplayFixtureWithTurns({ threadTitle: OWNER_THREAD_TITLE });
    const viewerFixture = await createResearchReplayFixtureWithTurns({ threadTitle: "Local colliding research thread" });
    let owner: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    let viewer: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      owner = await launchElectronApp({
        fixturePath: ownerFixture.fixturePath,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const profile = path.join(homeRoot, ".pwragent", "profiles", "default");
          await mkdir(profile, { recursive: true });
          await writeFile(
            path.join(profile, "config.toml"),
            [
              "[federation]",
              'mode = "gateway"',
              `instance_label = "${OWNER_LABEL}"`,
              'listen_host = "127.0.0.1"',
              "listen_port = 0",
              "",
            ].join("\n"),
          );
          enableResearchFixture(homeRoot);
          seedResearchState(stateDbPathForHomeRoot(homeRoot));
        },
      });
      await restoreE2eFederationIdentity({
        page: owner.window,
        identityPrivateKeyPem: generateFederationIdentityKeyPair().privateKeyPem,
        noiseStaticPrivateKeyBase64: generateFederationNoiseStaticKeyPair().privateKeyBase64,
        restartMode: "gateway",
      });
      await expect.poll(async () => owner!.window.evaluate(async () =>
        (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health),
      { timeout: 30_000 }).toMatchObject({
        status: "listening",
        listenUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      });

      // Seed a live research run owned by the running owner Electron process so review and stop controls are writable.
      seedLiveResearchRun(
        stateDbPathForHomeRoot(owner.homeRoot),
        readResearchOwnerIdentity(owner.homeRoot, owner.electronApp.process().pid!),
      );
      await owner.window.reload();

      const { instanceId: ownerInstanceId, invite } = await owner.window.evaluate(async () => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        return {
          instanceId: (await api.readFederationHealth!()).health.instanceId!,
          invite: (await api.generateFederationInvite!()).invite,
        };
      });

      viewer = await launchElectronApp({
        fixturePath: viewerFixture.fixturePath,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          enableResearchFixture(homeRoot);
        },
      });
      await restoreE2eFederationIdentity({
        page: viewer.window,
        identityPrivateKeyPem: generateFederationIdentityKeyPair().privateKeyPem,
        noiseStaticPrivateKeyBase64: generateFederationNoiseStaticKeyPair().privateKeyBase64,
      });
      await viewer.window.evaluate(async (encodedInvite) => {
        await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encodedInvite });
      }, invite);
      await expect.poll(async () => viewer!.window.evaluate(async () =>
        (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health),
      { timeout: 30_000 }).toMatchObject({ status: "connected" });

      await viewer.window.evaluate(async ({ instanceId, threadId, title, instanceLabel }) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        const ref = { backend: "codex" as const, threadId, target: { scope: "remote" as const, instanceId } };
        await api.addRemoteThreadPin!({
          ref,
          instanceLabel,
          summary: {
            id: threadId,
            source: "codex",
            title,
            titleSource: "explicit",
            linkedDirectories: [],
            inbox: { inInbox: true },
            updatedAt: 2_000,
            federation: {
              ref,
              instanceLabel,
              peerStatus: "connected",
              capabilities: ["thread_navigation", "thread_detail", "turn_control", "thread_research"],
            },
          },
        });
      }, {
        instanceId: ownerInstanceId,
        threadId: OWNER_THREAD_ID,
        title: REMOTE_PIN_TITLE,
        instanceLabel: OWNER_LABEL,
      });

      const page = viewer.window;
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: REMOTE_PIN_TITLE, exact: true }).click();
      await page.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = page.getByRole("region", { name: "Research", exact: true });
      const summary = panel.getByRole("region", { name: "Research run summary" });

      // Lists and reads the owner's runs, findings, and candidates.
      await expect(summary).toContainText(LIVE_RESEARCH_OBJECTIVE, { timeout: 15_000 });
      await expect(summary.getByText("Running", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Open in Research window", exact: true })).toHaveCount(0);

      await panel.getByRole("tab", { name: "Findings", exact: true }).click();
      await expect(panel.getByLabel("Shared findings")).toContainText("The failure still reproduces with only the in-memory store fixture.");
      // Remote evidence paths are shown as text and never offered as local-file open buttons.
      await expect(panel.getByText("test/cache/invalidation.test.ts", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: /Open evidence/i })).toHaveCount(0);

      // Reviews a candidate from the viewer and persists the decision on the owner.
      await panel.getByRole("tab", { name: /^Review\b/ }).click();
      const waiting = panel.getByRole("region", { name: "Candidates to review" });
      await expect(waiting.getByRole("article")).toHaveCount(1);
      const reviewReason = "Confirmed the 12-line reproducer from the Federation viewer.";
      await waiting.getByLabel("Reason for your decision").fill(reviewReason);
      await waiting.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(panel.getByRole("region", { name: "Reviewed candidates" })).toContainText(reviewReason, { timeout: 15_000 });
      await expect(panel.getByRole("region", { name: "Candidates to review" })).toHaveCount(0);

      // Confirm the owner's own Research tab shows the review decision immediately.
      await owner.window.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: OWNER_THREAD_TITLE, exact: true }).click();
      await owner.window.getByRole("tab", { name: "Research", exact: true }).click();
      const ownerPanel = owner.window.getByRole("region", { name: "Research", exact: true });
      await ownerPanel.getByRole("tab", { name: /^Review\b/ }).click();
      await expect(ownerPanel.getByRole("region", { name: "Reviewed candidates" })).toContainText(reviewReason, { timeout: 15_000 });

      // Stop the live run from the viewer and confirm both viewer and owner transition from Running to Stopping.
      await panel.getByRole("button", { name: "Stop run…", exact: true }).click();
      await panel.getByRole("button", { name: "Stop run", exact: true }).click();
      await expect(summary.getByText("Stopping", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByRole("button", { name: "Stop run…", exact: true })).toBeDisabled();
      await expect(ownerPanel.getByRole("region", { name: "Research run summary" }).getByText("Stopping", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Start a new native research request from the viewer -> pending request lives on owner -> withdraw clears it on owner.
      await panel.getByRole("button", { name: "New run", exact: true }).click();
      const remoteObjective = "Check retry jitter under backpressure across peers";
      await panel.getByLabel("Objective").fill(remoteObjective);
      await panel.getByRole("button", { name: "Request research", exact: true }).click();
      const pendingCard = panel.getByRole("region", { name: "Research request waiting to start" });
      await expect(pendingCard).toContainText(remoteObjective, { timeout: 15_000 });
      await expect(ownerPanel.getByRole("region", { name: "Research request waiting to start" })).toContainText(remoteObjective, { timeout: 15_000 });
      await pendingCard.getByRole("button", { name: "Withdraw request", exact: true }).click();
      await expect(pendingCard).toHaveCount(0, { timeout: 15_000 });
      await expect(ownerPanel.getByRole("region", { name: "Research request waiting to start" })).toHaveCount(0, { timeout: 15_000 });

      // Unconfigured Open Math Harness on the owner reports an honest per-instance state and omits local settings buttons.
      await panel.getByRole("button", { name: "New run", exact: true }).click();
      await panel.getByRole("button", { name: "Open Math Harness", exact: true }).click();
      await expect(panel.getByText(new RegExp(`Open Math Harness is not set up on ${OWNER_LABEL}`))).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText(/API keys never leave the owning machine/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "Open Harness settings", exact: true })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Show config.toml", exact: true })).toHaveCount(0);
      await panel.getByRole("button", { name: "Cancel", exact: true }).click();

      // Switch to the second historical run on the owner.
      await panel.getByRole("combobox", { name: "Run" }).click();
      await page.getByRole("option", { name: new RegExp(RESEARCH_FIXTURE_OBJECTIVE.slice(0, 30)) }).click();
      await expect(summary).toContainText(RESEARCH_FIXTURE_OBJECTIVE, { timeout: 15_000 });

      // The colliding local thread on the viewer remains untouched with zero local runs.
      await page.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Local colliding research thread", exact: true }).click();
      await expect(panel.getByRole("form", { name: "New research run" })).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText(LIVE_RESEARCH_OBJECTIVE)).toHaveCount(0);
      await expect(panel.getByText(RESEARCH_FIXTURE_OBJECTIVE)).toHaveCount(0);

      // Dedicated remote Federation window also renders the owner's Research runs.
      const remoteWindowPromise = viewer.electronApp.waitForEvent("window");
      await viewer.window.evaluate(async (instanceId) => {
        const api = (window as unknown as { pwragent?: DesktopApi }).pwragent;
        await api?.openFederationWindow?.({ target: { scope: "remote", instanceId } });
      }, ownerInstanceId);
      const remoteWindow = await remoteWindowPromise;
      await remoteWindow.waitForLoadState("domcontentloaded");
      await remoteWindow.emulateMedia({ reducedMotion: "reduce" });
      await remoteWindow.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: OWNER_THREAD_TITLE, exact: true }).click({ timeout: 30_000 });
      await remoteWindow.getByRole("tab", { name: "Research", exact: true }).click();
      const remotePanel = remoteWindow.getByRole("region", { name: "Research", exact: true });
      await expect(remotePanel.getByRole("region", { name: "Research run summary" })).toContainText(LIVE_RESEARCH_OBJECTIVE, { timeout: 15_000 });
      await expect(remotePanel.getByRole("region", { name: "Research run summary" }).getByText("Stopping", { exact: true })).toBeVisible();
      await expect(remotePanel.getByRole("button", { name: "Open in Research window", exact: true })).toHaveCount(0);
    } finally {
      await viewer?.close();
      await owner?.close();
      await viewerFixture.cleanup();
      await ownerFixture.cleanup();
    }
  });
});
