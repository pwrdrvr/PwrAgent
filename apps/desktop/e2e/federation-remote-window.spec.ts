import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { AppServerNotification, ThreadPrAutoDispatchPending, ThreadSubAgentSummary } from "@pwragent/shared";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { generateFederationIdentityKeyPair } from "../src/main/federation/federation-identity";
import { generateFederationNoiseStaticKeyPair } from "../src/main/federation/federation-noise";
import { applyDesktopSettingsPatch } from "../src/main/settings/desktop-config";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import { StateDb } from "../src/main/state/state-db";
import { launchElectronApp, rightClickThreadRow } from "./fixtures/electron-app";
import { tolerateTransientRpcFailure } from "./fixtures/transient-rpc-poll";
import {
  buildFakeAgentConfigToml,
  FEDERATION_CHILD_ENVIRONMENT_MARKER,
  findAllFakeCodexRequests,
  findFakeCodexRequest,
  readFakeCodexRequestLog,
  seedFakeCodexExecutable,
  seedFakeKimiExecutable,
  seedInstalledKimiParent,
} from "./fixtures/fake-agent-executables";
import {
  startInProcessFederationGateway,
  type InProcessFederationGateway,
} from "./fixtures/federation-gateway";

/**
 * Two-instance federation coverage: a REAL gateway (sqlite store, Noise
 * WebSocket transport, capability-checked router) runs inside the test
 * process; the launched Electron app enrolls into it as a genuine client
 * through the Settings UI. The only canned piece is the backend behind
 * the gateway's router, so invite redemption, the auth handshake, remote
 * navigation snapshots, and pin routing all exercise production code on
 * both ends of the wire.
 *
 * The environment-loss repro below uses a second, fully real owner app
 * with executable-backed Kimi + Codex fakes (no Codex replay fixture).
 */

// A model only the viewer's fake Codex offers. The owner's catalog is the
// fake's default: gpt-5.5, then gpt-5.
const VIEWER_ONLY_CODEX_MODEL = "gpt-viewer-only";

async function createLocalControlFixture(options?: {
  threadId?: string;
  threadTitle?: string;
  threadMessage?: string;
  notifications?: Array<{ id: string; notification: AppServerNotification }>;
}): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-federation-e2e-"),
  );
  const fixturePath = path.join(rootDir, "federation-local.fixture.json");
  const threadId = options?.threadId ?? "local-thread-1";
  const threadTitle = options?.threadTitle ?? "Local control thread";
  const threadMessage = options?.threadMessage ?? "Local thread is ready.";
  await writeFile(
    fixturePath,
    JSON.stringify({
      metadata: {
        backend: "codex",
        scenario: "federation-local-control",
      },
      steps: [
        {
          id: "initialize-1",
          kind: "response",
          method: "initialize",
          result: {
            serverInfo: { name: "Replay Codex", version: "1.0.0" },
            methods: [
              "thread/list",
              "thread/read",
              "skills/list",
              "thread/start",
              "turn/start",
              "review/start",
            ],
          },
        },
        {
          id: "thread-list-1",
          kind: "response",
          method: "thread/list",
          result: [
            {
              id: threadId,
              title: threadTitle,
              titleSource: "explicit",
              source: "codex",
              executionMode: "default",
              linkedDirectories: [],
              updatedAt: 1_000,
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
                id: "local-message-1",
                role: "assistant",
                text: threadMessage,
              },
            ],
            messages: [
              {
                id: "local-message-1",
                role: "assistant",
                text: threadMessage,
              },
            ],
            lastAssistantMessage: threadMessage,
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        },
        ...(options?.notifications ?? []).map((step) => ({ ...step, kind: "notification" })),
        {
          id: "thread-start-1",
          kind: "response",
          method: "thread/start",
          result: {
            threadId: "federated-environment-child",
          },
        },
        {
          id: "review-start-1",
          kind: "response",
          method: "review/start",
          result: {
            threadId: "federated-environment-child",
            reviewThreadId: "federated-environment-child",
            turnId: "federated-environment-review",
          },
        },
      ],
    }),
  );
  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    fixturePath,
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Expected a loopback TCP port for federation E2E");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
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
          replaceSettingsSecret?: (request: {
            secret: string;
            value: string;
          }) => Promise<unknown>;
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
        await api.writeSettingsConfig({
          patch: { federation: { mode: "disabled" } },
        });
        await api.writeSettingsConfig({
          patch: { federation: { mode: restartMode } },
        });
      }
    },
    {
      identityPrivateKeyPem: params.identityPrivateKeyPem,
      noiseStaticPrivateKeyBase64: params.noiseStaticPrivateKeyBase64,
      restartMode: params.restartMode,
    },
  );
}

async function setQuitConfirmation(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (nextEnabled) => {
    const api = (window as typeof window & {
      pwragent?: {
        writeSettingsConfig?: (request: unknown) => Promise<unknown>;
      };
    }).pwragent;
    if (!api?.writeSettingsConfig) {
      throw new Error("writeSettingsConfig API is unavailable");
    }
    await api.writeSettingsConfig({
      patch: {
        general: { confirmQuitWithInProgressThreads: nextEnabled },
      },
    });
  }, enabled);
}

function disableE2eFederationBeforeRelaunch(homeRoot: string): void {
  applyDesktopSettingsPatch(
    path.join(
      homeRoot,
      ".pwragent",
      "profiles",
      "default",
      "config.toml",
    ),
    { federation: { mode: "disabled" } },
  );
}

async function seedFixtureGitRepo(params: {
  repoDir: string;
  environmentSetupScript: string;
  commitMessage?: string;
  /**
   * When false, skip `git init` / branch creation (for already-materialized
   * worktrees). Defaults to true.
   */
  initializeGit?: boolean;
}): Promise<void> {
  await mkdir(path.join(params.repoDir, ".codex", "environments"), {
    recursive: true,
  });
  if (params.initializeGit !== false) {
    execFileSync("git", ["init"], { cwd: params.repoDir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], {
      cwd: params.repoDir,
      stdio: "ignore",
    });
  }
  await writeFile(
    path.join(params.repoDir, ".codex", "environments", "environment.toml"),
    [
      "version = 1",
      'name = "PwrAgent"',
      "",
      "[setup]",
      `script = ${JSON.stringify(params.environmentSetupScript)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["add", ".codex/environments/environment.toml"], {
    cwd: params.repoDir,
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PwrAgent Tests",
      "-c",
      "user.email=pwragent-tests@example.invalid",
      "commit",
      "-m",
      params.commitMessage ?? "Seed fixture repo",
    ],
    { cwd: params.repoDir, stdio: "ignore" },
  );
}

test.describe("federation remote window", () => {
  test("renders and refreshes owner sub-agents in the local main window through the real federation runtime", async ({ browserName: _browserName }, testInfo) => {
    test.setTimeout(180_000);
    const threadId = "colliding-subagent-parent";
    const workerId = "fixture-live-worker";
    const task = "Inspect the contrived federation delivery path";
    const ownerIdentity = generateFederationIdentityKeyPair();
    const ownerNoiseIdentity = generateFederationNoiseStaticKeyPair();
    const viewerIdentity = generateFederationIdentityKeyPair();
    const viewerNoiseIdentity = generateFederationNoiseStaticKeyPair();
    const port = await reserveLoopbackPort();
    const lifecycle = (completed: boolean): AppServerNotification => ({
      method: "item/completed",
      params: {
        threadId, turnId: "fixture-parent-turn",
        item: {
          id: completed ? "fixture-wait" : "fixture-spawn", type: "collabAgentToolCall",
          tool: completed ? "wait" : "spawnAgent", status: "completed", receiverThreadIds: [workerId],
          prompt: task, model: "gpt-5.4-mini", reasoningEffort: "medium",
          agentsStates: { [workerId]: { status: completed ? "completed" : "running",
            agentNickname: "Delivery inspector", message: completed ? "Delivery verified on the owner." : "Inspecting delivery on the owner." } },
        },
      },
    });
    const ownerMessage = "This transcript was read from the fixture owner.";
    const ownerFixture = await createLocalControlFixture({ threadId, threadTitle: "Peer sub-agent parent", threadMessage: ownerMessage,
      notifications: [{ id: "spawn-worker", notification: lifecycle(false) }, { id: "complete-worker", notification: lifecycle(true) }],
    });
    const localFixture = await createLocalControlFixture({ threadId, threadTitle: "Local colliding parent" });
    let owner: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    let viewer: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      owner = await launchElectronApp({ fixturePath: ownerFixture.fixturePath, secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const profile = path.join(homeRoot, ".pwragent", "profiles", "default");
          await mkdir(path.join(profile, "state"), { recursive: true });
          await writeFile(path.join(profile, "config.toml"), ["[federation]", 'mode = "gateway"',
            'instance_label = "Fixture sub-agent owner"', 'listen_host = "127.0.0.1"', `listen_port = ${port}`,
            `public_url = "ws://127.0.0.1:${port}"`, ""].join("\n"));
          const db = StateDb.open(path.join(profile, "state", "state.db"));
          try {
            const store = new SqliteOverlayStore(db);
            const now = Date.now();
            const histories: ThreadSubAgentSummary[] = Array.from({ length: 21 }, (_, index) => ({
              monitorId: `codex-native:fixture-history-${index}`, agentName: `Historical worker ${index}`,
              task: `Completed contrived task ${index}`, status: "success", createdAt: now - 40_000 - index,
              updatedAt: now - 30_000, completedAt: now - 30_000,
            }));
            histories.push({ monitorId: "system:token-miser:fixture-gate", task: "Contrived Token Miser gate", status: "success", createdAt: now - 40_000, updatedAt: now - 30_000 },
              { monitorId: "review:fixture-review", task: "Contrived PwrAgent review", status: "success", createdAt: now - 40_000, updatedAt: now - 30_000 });
            for (const subAgent of histories) await store.upsertThreadSubAgent({ backend: "codex", threadId, subAgent });
          } finally { db.close(); }
        },
      });
      await restoreE2eFederationIdentity({ page: owner.window, identityPrivateKeyPem: ownerIdentity.privateKeyPem,
        noiseStaticPrivateKeyBase64: ownerNoiseIdentity.privateKeyBase64, restartMode: "gateway" });
      // An instance id exists before a gateway binds. Require the actual
      // listener after identity restoration before minting an invite for it.
      await expect.poll(async () => owner!.window.evaluate(async () =>
        (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health),
      { timeout: 30_000 }).toMatchObject({ status: "listening", listenUrl: `ws://127.0.0.1:${port}` });
      const ownerInstanceId = await owner.window.evaluate(async () =>
        (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.instanceId);
      expect(ownerInstanceId).toBeTruthy();
      const invite = await owner.window.evaluate(async () => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        return (await api.generateFederationInvite!()).invite;
      });
      viewer = await launchElectronApp({ fixturePath: localFixture.fixturePath, secretStorage: "memory" });
      await restoreE2eFederationIdentity({ page: viewer.window, identityPrivateKeyPem: viewerIdentity.privateKeyPem,
        noiseStaticPrivateKeyBase64: viewerNoiseIdentity.privateKeyBase64 });
      await viewer.window.evaluate(async (encodedInvite) => {
        await (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: encodedInvite });
      }, invite);
      await expect.poll(async () => viewer!.window.evaluate(async () =>
        (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health),
      { timeout: 30_000 }).toMatchObject({ status: "connected" });
      await viewer.window.evaluate(async ({ instanceId, id }) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        const ref = { backend: "codex" as const, threadId: id, target: { scope: "remote" as const, instanceId } };
        await api.addRemoteThreadPin!({ ref, instanceLabel: "Fixture sub-agent owner", summary: {
          id, source: "codex", title: "Peer sub-agent parent", titleSource: "explicit", linkedDirectories: [],
          inbox: { inInbox: true }, updatedAt: 2_000, federation: { ref, instanceLabel: "Fixture sub-agent owner", peerStatus: "connected" },
        } });
      }, { instanceId: ownerInstanceId!, id: threadId });

      const page = viewer.window;
      const selectPeer = async () => {
        await page.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Peer sub-agent parent", exact: true }).click();
        await page.getByRole("tab", { name: "Sub-agents", exact: true }).click();
      };
      await selectPeer();
      await expect(page.getByText("Historical worker 0", { exact: true })).toBeVisible();
      await expect(page.getByText("Historical worker 20", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Load more sub-agents" }).click();
      await expect(page.getByText("Historical worker 20", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Token Miser 1", exact: true }).click();
      await expect(page.getByText("Contrived Token Miser gate", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "PwrAgent 1", exact: true }).click();
      await expect(page.getByText("Contrived PwrAgent review", { exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "Harness 21", exact: true }).click();

      // Only the provider notification is replayed. Persistence, owner display
      // reads, subscriptions, wire transport, preload, hooks and DOM are real.
      await owner.advance({ stepId: "spawn-worker" });
      const card = page.locator(".rail-card").filter({ hasText: task });
      await expect(card.getByText("Delivery inspector", { exact: true })).toBeVisible();
      await expect(card.getByText("Running", { exact: true })).toBeVisible();
      await expect(page.locator(".live-strip").getByText("Delivery inspector", { exact: true })).toBeVisible();
      const browser = page.getByRole("region", { name: "Thread browser" });
      await browser.getByRole("button", { name: "Expand 1 native Codex sub-agents for Peer sub-agent parent", exact: true }).click();
      await expect(browser.getByRole("button", { name: "Open transcript for Delivery inspector", exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Details", exact: true }).click();
      const details = page.getByRole("dialog", { name: "Sub-agent details: Delivery inspector" });
      await expect(details.getByText(task, { exact: true })).toBeVisible();
      await owner.advance({ stepId: "complete-worker" });
      await expect(details.getByText("Delivery verified on the owner.", { exact: true })).toBeVisible();
      await expect(details.getByText("Completed", { exact: true })).toBeVisible();
      await expect(page.locator(".live-strip").getByText("Delivery inspector", { exact: true })).toHaveCount(0);
      await details.getByRole("button", { name: "Close", exact: true }).click();
      await page.screenshot({ path: testInfo.outputPath("peer-subagents-visible.png") });

      await page.getByRole("region", { name: "Thread browser" }).getByRole("button", { name: "Local colliding parent", exact: true }).click();
      await expect(page.getByText(/No sub-agents yet/)).toBeVisible();
      await expect(page.getByText(task, { exact: true })).toHaveCount(0);
      await page.reload();
      await selectPeer();
      await expect(card.getByText("Completed", { exact: true })).toBeVisible();
      await expect(card.getByText("Delivery inspector", { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "Details", exact: true }).click();
      const transcriptOpened = viewer.electronApp.waitForEvent("window");
      await page.getByRole("dialog").getByRole("button", { name: "Open transcript", exact: true }).click();
      const transcript = await transcriptOpened;
      await expect(transcript.getByRole("heading", { name: "Delivery inspector", exact: true })).toBeVisible();
      await expect(transcript.getByText(workerId, { exact: true })).toBeVisible();
      await expect(transcript.getByText(ownerMessage, { exact: true })).toBeVisible();
      await transcript.getByRole("button", { name: "Close window", exact: true }).click();
    } finally {
      await viewer?.close();
      await owner?.close();
      await localFixture.cleanup();
      await ownerFixture.cleanup();
    }
  });

  test("cancels a colliding remote auto-fix without changing the local thread", async () => {
    test.setTimeout(180_000);

    const threadId = "colliding-thread-id";
    const now = Date.now();
    const localPending: ThreadPrAutoDispatchPending = {
      fingerprint: "local-auto-fix",
      prKey: "github.com/local/repo#41",
      prNumber: 41,
      prTitle: "Keep the local pending repair",
      prUrl: "https://github.com/local/repo/pull/41",
      headSha: "local-head",
      eventKinds: ["ci-failure"],
      createdAt: now,
      scheduledAt: now + 120_000,
    };
    const remotePending: ThreadPrAutoDispatchPending = {
      fingerprint: "remote-auto-fix",
      prKey: "github.com/remote/repo#42",
      prNumber: 42,
      prTitle: "Cancel the remote pending repair",
      prUrl: "https://github.com/remote/repo/pull/42",
      headSha: "remote-head",
      eventKinds: ["ci-failure"],
      createdAt: now,
      scheduledAt: now + 120_000,
    };
    const fixture = await createLocalControlFixture({
      threadId,
      threadTitle: "Local colliding thread",
    });
    let gateway: InProcessFederationGateway | undefined;
    let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;

    try {
      gateway = await startInProcessFederationGateway({
        instanceLabel: "Remote collision owner",
        threads: [{
          id: threadId,
          title: "Remote colliding thread",
          updatedAt: 2_000,
          prAutoDispatchPending: remotePending,
        }],
      });
      app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const statePath = path.join(
            homeRoot,
            ".pwragent",
            "profiles",
            "default",
            "state",
            "state.db",
          );
          await mkdir(path.dirname(statePath), { recursive: true });
          const stateDb = StateDb.open(statePath);
          try {
            const store = new SqliteOverlayStore(stateDb);
            await store.setThreadPrAutoDispatchEnabled({
              backend: "codex",
              threadId,
              enabled: true,
            });
            const scheduled = await store.scheduleThreadPrAutoDispatch({
              backend: "codex",
              threadId,
              pending: localPending,
              prompt: "Repair the local PR",
              maxAttempts: 2,
            });
            if (scheduled.status !== "scheduled") {
              throw new Error(
                `Failed to seed local auto-fix: ${scheduled.status}`,
              );
            }
          } finally {
            stateDb.close();
          }
        },
      });
      const { window } = app;

      const localRow = window.getByRole("region", { name: "Thread browser" }).getByRole("button", {
        name: "Local colliding thread",
        exact: true,
      });
      await expect(localRow).toBeVisible({ timeout: 30_000 });
      await localRow.click();
      await expect(window.getByText("Local thread is ready.")).toBeVisible();
      await expect(window.getByText("#41 · CI failed")).toBeVisible();

      await window.getByRole("button", { name: "Open settings" }).click();
      await window
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Federation", exact: true })
        .click();
      await window.getByLabel("Import invite").fill(gateway.invite);
      await window.getByRole("button", { name: "Import invite" }).click();
      await gateway.waitForConnection(30_000);

      await window.evaluate(async ({ instanceId, pending, threadId: remoteThreadId }) => {
        const api = (window as typeof window & {
          pwragent?: {
            addRemoteThreadPin?: (request: unknown) => Promise<unknown>;
          };
        }).pwragent;
        if (!api?.addRemoteThreadPin) {
          throw new Error("addRemoteThreadPin API is unavailable");
        }
        await api.addRemoteThreadPin({
          ref: {
            backend: "codex",
            target: { scope: "remote", instanceId },
            threadId: remoteThreadId,
          },
          instanceLabel: "Remote collision owner",
          summary: {
            source: "codex",
            id: remoteThreadId,
            title: "Remote colliding thread",
            titleSource: "explicit",
            linkedDirectories: [],
            inbox: { inInbox: true },
            updatedAt: 2_000,
            prAutoDispatchPending: pending,
            federation: {
              ref: {
                backend: "codex",
                target: { scope: "remote", instanceId },
                threadId: remoteThreadId,
              },
              instanceLabel: "Remote collision owner",
              peerStatus: "connected",
            },
          },
        });
      }, {
        instanceId: gateway.instanceId,
        pending: remotePending,
        threadId,
      });
      await window.getByRole("button", { name: /Exit Settings/i }).click();
      const collidingSnapshotThreads = await window.evaluate(
        async ({ collidingThreadId, ownerInstanceId }) => {
          const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
          const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", inventory: "viewer",
            query: { kind: "exact", identities: [
              { backend: "codex", threadId: collidingThreadId },
              { backend: "codex", threadId: collidingThreadId, ownerInstanceId },
            ] },
          });
          return page.entries.map(({ row }) => ({
            instanceId: row.federation?.ref.target.scope === "remote" ? row.federation.ref.target.instanceId : undefined,
            title: row.title,
          }));
        },
        { collidingThreadId: threadId, ownerInstanceId: gateway.instanceId },
      );
      expect(collidingSnapshotThreads).toEqual(expect.arrayContaining([
        { instanceId: undefined, title: "Local colliding thread" },
        {
          instanceId: gateway.instanceId,
          title: "Remote colliding thread",
        },
      ]));
      await expect.poll(async () =>
        await window.locator(".thread-row__open").evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label"))
        )
      ).toEqual(expect.arrayContaining([
        "Local colliding thread",
        "Remote colliding thread",
      ]));

      const remoteRow = window.getByRole("button", {
        name: "Remote colliding thread",
        exact: true,
      }).first();
      await expect(remoteRow).toBeVisible({ timeout: 30_000 });
      await remoteRow.click();
      await expect(
        window.getByText("Remote transcript for Remote colliding thread."),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.getByText("#42 · CI failed")).toBeVisible();

      await window.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() =>
        gateway!.calls.find((call) =>
          call.method === "cancelThreadPrAutoDispatch"
        )
      ).toMatchObject({
        method: "cancelThreadPrAutoDispatch",
        params: {
          backend: "codex",
          threadId,
          fingerprint: remotePending.fingerprint,
        },
      });

      gateway.deliverBackendEvent({
        backend: "codex",
        notification: {
          method: "thread/prAutoDispatch/pendingUpdated",
          params: { threadId, pending: null },
        },
      });
      await expect(window.getByText("#42 · CI failed")).toHaveCount(0);

      await localRow.click();
      await expect(window.getByText("Local thread is ready.")).toBeVisible();
      await expect(window.getByText("#41 · CI failed")).toBeVisible();
      await expect(
        window.getByRole("region", { name: "Thread browser" })
          .getByRole("button", { name: "Remote colliding thread" }),
      ).toHaveCount(1);
      await expect(
        window.getByRole("region", { name: "Thread browser" })
          .getByRole("button", { name: "Local colliding thread" }),
      ).toHaveCount(1);
      await expect(
        window.locator(".thread-row__open[aria-pressed=\"true\"]"),
      ).toHaveCount(1);
    } finally {
      await app?.close();
      await gateway?.close();
      await fixture.cleanup();
    }
  });

  test("retries an offline mounted thread after the peer reconnects and the row is reselected", async () => {
    test.setTimeout(180_000);

    const fixture = await createLocalControlFixture();
    let gateway: InProcessFederationGateway | undefined;
    let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;

    try {
      gateway = await startInProcessFederationGateway({
        instanceLabel: "Remote reconnect owner",
        threads: [{
          id: "remote-reconnect-thread",
          title: "Remote reconnect thread",
          updatedAt: 2_000,
        }],
      });
      app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
        secretStorage: "memory",
      });
      const { window } = app;

      const localRow = window.getByRole("button", {
        name: "Local control thread",
      });
      await expect(localRow).toBeVisible({ timeout: 30_000 });
      await localRow.click();
      await expect(window.getByText("Local thread is ready.")).toBeVisible();

      await window.getByRole("button", { name: "Open settings" }).click();
      await window
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Federation", exact: true })
        .click();
      await window.getByLabel("Import invite").fill(gateway.invite);
      await window.getByRole("button", { name: "Import invite" }).click();
      await gateway.waitForConnection(30_000);

      await window.evaluate(async ({ instanceId }) => {
        const api = (window as typeof window & {
          pwragent?: {
            addRemoteThreadPin?: (request: unknown) => Promise<unknown>;
          };
        }).pwragent;
        if (!api?.addRemoteThreadPin) {
          throw new Error("addRemoteThreadPin API is unavailable");
        }
        await api.addRemoteThreadPin({
          ref: {
            backend: "codex",
            target: { scope: "remote", instanceId },
            threadId: "remote-reconnect-thread",
          },
          instanceLabel: "Remote reconnect owner",
          summary: {
            source: "codex",
            id: "remote-reconnect-thread",
            title: "Remote reconnect thread",
            titleSource: "explicit",
            linkedDirectories: [],
            inbox: { inInbox: true },
            updatedAt: 2_000,
            federation: {
              ref: {
                backend: "codex",
                target: { scope: "remote", instanceId },
                threadId: "remote-reconnect-thread",
              },
              instanceLabel: "Remote reconnect owner",
              peerStatus: "connected",
            },
          },
        });
      }, { instanceId: gateway.instanceId });
      await window.getByRole("button", { name: /Exit Settings/i }).click();

      const remoteRow = window.getByRole("button", {
        name: "Remote reconnect thread",
      });
      await expect(remoteRow).toBeVisible({ timeout: 30_000 });

      await gateway.stop();
      await remoteRow.click();
      await expect(
        window.locator(".federation-disconnected-banner"),
      ).toBeVisible({ timeout: 30_000 });
      // Peer readiness suspends hydration before IPC, so the expected outage
      // state is the reconnecting banner without a raw handler exception.
      await expect(window.locator(".transcript-error")).toHaveCount(0);

      await localRow.click();
      await expect(window.getByText("Local thread is ready.")).toBeVisible();

      await gateway.restart();
      await gateway.waitForNextConnection(90_000);
      await expect(
        window.locator(".federation-disconnected-banner"),
      ).toHaveCount(0, { timeout: 60_000 });

      await remoteRow.click();
      await expect(
        window.getByText("Remote transcript for Remote reconnect thread."),
      ).toBeVisible({ timeout: 30_000 });
      await expect(window.locator(".transcript-error")).toHaveCount(0);
    } finally {
      await app?.close();
      await gateway?.close();
      await fixture.cleanup();
    }
  });

  test("enrolls, browses remote threads, routes mounted quit blockers, and hides local-only chrome", async () => {
    test.setTimeout(300_000);

    let gateway: InProcessFederationGateway | undefined;
    const fixture = await createLocalControlFixture();
    // The OWNER-side worktree: the remote shell's cwd lives in the test
    // process, so a marker file appearing here proves where the PTY ran.
    const ownerPtyCwd = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-federation-e2e-pty-"),
    );
    const fixtureRepo = path.join(ownerPtyCwd, "FixtureRepo");
    const ownerOnlyEnvironmentRepo = path.posix.join(
      "/owner-only",
      path.basename(ownerPtyCwd),
      "EnvironmentRepo",
    );
    expect(existsSync(ownerOnlyEnvironmentRepo)).toBe(false);
    await seedFixtureGitRepo({
      repoDir: fixtureRepo,
      environmentSetupScript: "printf federation-child-environment",
      commitMessage: "Seed fixture repo",
    });
    let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      gateway = await startInProcessFederationGateway({
        instanceLabel: "E2E Gateway",
        remotePty: { cwd: ownerPtyCwd },
        directories: [
          {
            key: "directory:/remote/FixtureRepo",
            label: "FixtureRepo",
            path: "/remote/FixtureRepo",
            threadIds: ["remote-thread-1", "remote-thread-2"],
          },
          {
            key: `directory:${ownerOnlyEnvironmentRepo}`,
            label: "EnvironmentRepo",
            path: ownerOnlyEnvironmentRepo,
            threadIds: ["remote-kimi-parent"],
            codexEnvironmentOptions: [
              {
                id: "environment",
                name: "PwrAgent",
                sourcePath: path.join(
                  ownerOnlyEnvironmentRepo,
                  ".codex",
                  "environments",
                  "environment.toml",
                ),
                setupScript: "printf federation-child-environment",
                actions: [],
              },
            ],
          },
        ],
        threads: [
          {
            id: "remote-thread-1",
            title: "Remote gateway thread one",
            updatedAt: 2_000,
          },
          {
            id: "remote-thread-2",
            title: "Remote gateway thread two",
            updatedAt: 1_000,
          },
          {
            id: "remote-kimi-parent",
            title: "Remote Kimi parent",
            updatedAt: 1_500,
            source: "acp:kimi",
            executionMode: "default",
            linkedDirectories: [
              {
                id: ownerOnlyEnvironmentRepo,
                label: "EnvironmentRepo",
                path: ownerOnlyEnvironmentRepo,
                worktreePath: ownerOnlyEnvironmentRepo,
                kind: "worktree",
              },
            ],
          },
        ],
      });

      // Federation key material needs a writable secret store.
      app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const { executablePath: fakeKimiPath } =
            await seedFakeKimiExecutable(homeRoot);
          const configPath = path.join(
            homeRoot,
            ".pwragent",
            "profiles",
            "default",
            "config.toml",
          );
          await mkdir(path.dirname(configPath), { recursive: true });
          await writeFile(
            configPath,
            [
              "[acp_agents.kimi]",
              `cli_path = ${JSON.stringify(fakeKimiPath)}`,
              "",
            ].join("\n"),
            "utf8",
          );
        },
      });
      const { electronApp, window } = app;

      // Local control: the local main window has the local-only chrome.
      await expect(
        window.getByRole("button", { name: "Open settings" }),
      ).toBeVisible();
      await expect(
        window.getByRole("button", { name: "Open automations" }),
      ).toBeVisible();

      // Enroll through the real Settings flow: paste the invite, import,
      // and wait for the client runtime to connect to the gateway.
      await window.getByRole("button", { name: "Open settings" }).click();
      await window
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Federation", exact: true })
        .click();
      await window.getByLabel("Import invite").fill(gateway.invite);
      await window.getByRole("button", { name: "Import invite" }).click();
      await expect(
        window.getByText(/Invite imported\. Connecting to /),
      ).toBeVisible();

      await gateway.waitForConnection(30_000);
      const connectionSection = window.getByRole("region", {
        name: "Connection",
      });
      await expect(
        connectionSection.getByText("Connected", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      // Browse the peer: a dedicated remote window opens.
      const remoteWindowPromise = electronApp.waitForEvent("window");
      await window
        .getByRole("button", { name: "Browse remote threads" })
        .click();
      const remote = await remoteWindowPromise;
      await remote.waitForLoadState("domcontentloaded");

      // The window is branded as the peer and carries the remote target.
      // (The client-side peer label defaults to "Gateway" for the enrolled
      // gateway — assert the remote branding, not the exact label.)
      await expect(remote.locator(".sidebar__federation-label")).toContainText(
        /^Remote · /,
      );
      const target = await remote.evaluate(
        () =>
          (window as typeof window & {
            __pwragentFederationTarget?: { scope: string; instanceId: string };
          }).__pwragentFederationTarget,
      );
      expect(target?.scope).toBe("remote");
      expect(target?.instanceId).toBe(gateway.instanceId);

      // The OS-level window title must keep the peer label — the
      // renderer's static <title> used to clobber it back to the app
      // name, collapsing every window to one entry in the macOS Window
      // menu.
      const peerTitled = tolerateTransientRpcFailure(async () =>
        (
          await electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((win) => win.getTitle()),
          )
        ).some((title) => /^PwrAgent - ./.test(title)));
      await expect
        .poll(peerTitled.read)
        .toBe(true)
        .catch(peerTitled.rethrowWithLastFailure);

      // The peer's threads render; the local thread does not leak in.
      await expect(
        remote.locator(".thread-row__title", {
          hasText: "Remote gateway thread one",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        remote.locator(".thread-row__title", {
          hasText: "Remote gateway thread two",
        }),
      ).toBeVisible();
      await expect(remote.getByText("Local control thread")).toHaveCount(0);

      // Mount one remote thread into the local main window. This is the same
      // viewer-owned pin path as choosing a federated result from Cmd+K, but
      // invoking the bridge directly keeps this E2E focused on reconnect
      // behavior instead of duplicating the search-popup suite.
      await window.evaluate(async ({ instanceId }) => {
        const api = (window as typeof window & {
          pwragent?: {
            addRemoteThreadPin?: (request: unknown) => Promise<unknown>;
          };
        }).pwragent;
        if (!api?.addRemoteThreadPin) {
          throw new Error("addRemoteThreadPin API is unavailable");
        }
        await api.addRemoteThreadPin({
          ref: {
            backend: "codex",
            target: { scope: "remote", instanceId },
            threadId: "remote-thread-1",
          },
          instanceLabel: "E2E Gateway",
          summary: {
            source: "codex",
            id: "remote-thread-1",
            title: "Remote gateway thread one",
            titleSource: "explicit",
            linkedDirectories: [],
            inbox: { inInbox: true },
            updatedAt: 2_000,
            federation: {
              ref: {
                backend: "codex",
                target: { scope: "remote", instanceId },
                threadId: "remote-thread-1",
              },
              instanceLabel: "E2E Gateway",
              peerStatus: "connected",
            },
          },
        });
      }, { instanceId: gateway.instanceId });
      await window.getByRole("button", { name: /Exit Settings/i }).click();
      const locallyMountedRemoteRow = window.getByRole("button", {
        name: "Remote gateway thread one",
        exact: true,
      });
      // Row state (selection, offline dim) lives on the CARD; the button is
      // only the title line inside it, because the chip flow beside it
      // carries buttons of its own (see ThreadRow).
      const locallyMountedRemoteCard = window.locator(".thread-row", {
        has: locallyMountedRemoteRow,
      });
      await expect(locallyMountedRemoteRow).toBeVisible({ timeout: 30_000 });
      await expect(locallyMountedRemoteCard).not.toHaveClass(/is-remote-offline/);
      await locallyMountedRemoteRow.click();
      await expect(
        window.getByText(/Remote transcript for Remote gateway thread one/),
      ).toBeVisible({ timeout: 30_000 });

      // A mounted remote thread can own a remote PTY inside the LOCAL viewer.
      // That is distinct from the dedicated remote window below: the quit
      // dialog must route both the terminal reveal and the thread selection
      // back to this viewer, with the owning federation instance preserved.
      const mountedTerminalToggle = window.locator(
        ".composer__terminal-toggle",
      );
      await mountedTerminalToggle.click();
      await expect(
        window.getByLabel("Integrated terminal", { exact: true }),
      ).toBeVisible();
      await expect(window.locator(".integrated-terminal__status")).toHaveText(
        ownerPtyCwd,
        { timeout: 30_000 },
      );

      // An idle shell is not a quit blocker. That holds for a remote shell
      // too: the owner reports this one's foreground state over `pty.state`
      // and the viewer filters on it exactly as it does for a local shell.
      // Start a foreground command so the dialog below has a row to route.
      await window.locator(".integrated-terminal__viewport").click();
      await window.keyboard.type(
        "echo PWRAGENT_REMOTE_QUIT_BLOCKER_READY; sleep 120",
      );
      await window.keyboard.press("Enter");
      await expect(
        window.locator(".integrated-terminal .xterm-rows"),
      ).toContainText("PWRAGENT_REMOTE_QUIT_BLOCKER_READY", {
        timeout: 30_000,
      });
      // The marker only proves `echo` finished. The owner derives the state
      // from the command's own output and streams it back, so wait on the
      // exact main-process snapshot QuitManager reads — quitting before it
      // arrives correctly sees no blocker and exits without a prompt.
      await expect
        .poll(
          async () => (await app!.getIntegratedTerminalQuitSnapshot())?.count ?? 0,
          { timeout: 30_000 },
        )
        .toBe(1);

      // Now view a local thread, matching the operator repro. If the quit row
      // loses its federation target, the renderer cannot match the mounted
      // remote row and stays here.
      await window
        .getByRole("button", { name: "Local control thread" })
        .click();
      await expect(window.getByText("Local thread is ready.")).toBeVisible();
      await setQuitConfirmation(window, true);

      const quitDialogPromise = electronApp.waitForEvent("window");
      void electronApp
        .evaluate(({ app: electronApp }) => electronApp.quit())
        .catch(() => undefined);
      const quitDialog = await quitDialogPromise;
      await expect(
        quitDialog.getByRole("heading", { name: "Quit PwrAgent?" }),
      ).toBeVisible();
      const mountedRemoteQuitRow = quitDialog.locator("a.row", {
        hasText: "Remote gateway thread one",
      });
      await expect(mountedRemoteQuitRow).toHaveCount(1);
      await mountedRemoteQuitRow.dispatchEvent("click");
      await quitDialog.waitForEvent("close");

      await expect(
        window.getByText(/Remote transcript for Remote gateway thread one/),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        window.getByLabel("Integrated terminal", { exact: true }),
      ).toBeVisible();

      // Disarm the quit guard before releasing the mounted session and moving
      // on to the dedicated-remote-window coverage below.
      await setQuitConfirmation(window, false);
      await window.getByRole("region", { name: "Thread terminals", exact: true })
        .getByRole("tab").press("Delete");
      await expect(
        window.getByLabel("Integrated terminal", { exact: true }),
      ).toHaveCount(0);

      // Local-only chrome stays hidden in the remote window.
      await expect(
        remote.getByRole("button", { name: "Open settings" }),
      ).toHaveCount(0);
      await expect(
        remote.getByRole("button", { name: "Open automations" }),
      ).toHaveCount(0);
      await expect(remote.locator(".messaging-status-bar")).toHaveCount(0);

      // Hiding the sidebar relocates the masthead into the title bar.
      // The relocated copy must ALSO hide Settings/Automations, and the
      // remote-instance badge takes over as the window's remote marker
      // (the sidebar identity pill left with the sidebar).
      await remote.getByRole("button", { name: "Hide sidebar" }).click();
      await expect(
        remote.getByRole("button", { name: "Search threads" }),
      ).toBeVisible();
      await expect(
        remote.getByRole("button", { name: "Open settings" }),
      ).toHaveCount(0);
      await expect(
        remote.getByRole("button", { name: "Open automations" }),
      ).toHaveCount(0);
      await expect(
        remote.getByRole("button", { name: /^Remote instance: / }),
      ).toBeVisible();
      await remote.getByRole("button", { name: "Show sidebar" }).click();

      // Opening a remote thread renders the peer transcript with the
      // remote-PTY terminal toggle enabled (the gateway granted remote_pty).
      const remoteRowOne = remote.getByRole("region", { name: "Thread browser" }).getByRole("button", {
        name: "Remote gateway thread one",
        exact: true,
      });
      const remoteCardOne = remote.locator(".thread-row", {
        // `has` resolves inside each row; the browser-region locator above
        // cannot resolve there because that region is the row's ancestor.
        has: remote.getByRole("button", { name: "Remote gateway thread one", exact: true }),
      });
      await remoteRowOne.click();
      await expect(
        remote.getByText(/Remote transcript for Remote gateway thread one/),
      ).toBeVisible({ timeout: 30_000 });
      const terminalToggle = remote.locator(".composer__terminal-toggle");
      await expect(terminalToggle).toBeVisible();
      await expect(terminalToggle).not.toHaveClass(/is-disabled/);

      // Open the remote terminal: the panel attaches to a PTY spawned inside
      // the gateway's process, and the status line shows the OWNER-resolved
      // cwd (the viewer never sent a path).
      await terminalToggle.click();
      await expect(
        remote.getByLabel("Integrated terminal", { exact: true }),
      ).toBeVisible();
      await expect(remote.locator(".integrated-terminal__status")).toHaveText(
        ownerPtyCwd,
        { timeout: 30_000 },
      );

      // Run a command through the remote shell. The marker lands in the
      // gateway process's temp worktree — proof the process ran on the owner
      // — and its output streams back into the viewer's xterm.
      const markerToken = `pwragent-remote-pty-${Date.now().toString(36)}`;
      await remote.locator(".integrated-terminal__viewport").click();
      await remote.keyboard.type(`echo ${markerToken}>remote-pty-marker.txt`);
      await remote.keyboard.press("Enter");
      const markerPath = path.join(ownerPtyCwd, "remote-pty-marker.txt");
      await expect
        .poll(() => existsSync(markerPath), { timeout: 30_000 })
        .toBe(true);
      expect((await readFile(markerPath, "utf8")).trim()).toContain(markerToken);

      await remote.keyboard.type(`echo viewer-sees-${markerToken}`);
      await remote.keyboard.press("Enter");
      await expect(
        remote.locator(".integrated-terminal .xterm-rows"),
      ).toContainText(`viewer-sees-${markerToken}`, { timeout: 30_000 });

      // Closing the pane releases the remote session (the owner reaps it
      // after its grace period).
      await remote.getByRole("region", { name: "Thread terminals", exact: true })
        .getByRole("tab").press("Delete");
      await expect(
        remote.getByLabel("Integrated terminal", { exact: true }),
      ).toHaveCount(0);

      // Security invariant ("no local fallback"): a remote window's PR
      // lookup must be refused by the main process, never run against
      // this machine's paths and GitHub credentials.
      const refreshError = await remote.evaluate(async () => {
        const api = (window as typeof window & {
          pwragent?: {
            refreshThreadPullRequests?: (request: unknown) => Promise<unknown>;
          };
        }).pwragent;
        if (!api?.refreshThreadPullRequests) {
          return "missing-api";
        }
        try {
          await api.refreshThreadPullRequests({
            backend: "codex",
            threadId: "remote-thread-1",
            trigger: "user",
            branch: "main",
            directoryPaths: [],
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
      expect(refreshError).toContain("owning instance");

      // Pin/unpin propagates to the OWNING instance's store, not the
      // viewer's: the canned gateway backend records the routed write.
      await rightClickThreadRow(remote, "Remote gateway thread one");
      await remote.getByRole("menuitemcheckbox", { name: "Pinned" }).click();
      // Pinned is a checkable item: the menu stays open after a toggle.
      await remote.keyboard.press("Escape");
      await expect
        .poll(() => gateway!.pinnedRankByThreadId.get("remote-thread-1") ?? null, {
          timeout: 15_000,
        })
        .not.toBeNull();
      const pinCall = gateway.calls.find(
        (call) => call.method === "setThreadPin",
      );
      expect(pinCall).toBeTruthy();

      // The row is PINNED here — right-click the card, not the open
      // button: the in-title unpin pin can sit at the button's center
      // and Playwright's hit-target check then refuses the click.
      await rightClickThreadRow(remote, "Remote gateway thread one");
      await remote.getByRole("menuitemcheckbox", { name: "Pinned" }).click();
      // Pinned is a checkable item: the menu stays open after a toggle.
      await remote.keyboard.press("Escape");
      await expect
        .poll(() => gateway!.pinnedRankByThreadId.get("remote-thread-1") ?? null, {
          timeout: 15_000,
        })
        .toBeNull();

      // Remote launchpad drafts live in the viewer's overlay store while the
      // user composes. After a successful remote materialization, reopening
      // the same launchpad must start empty instead of rehydrating the message
      // that was already submitted.
      await remote.getByRole("tab", { name: "directories" }).click();
      const openRemoteLaunchpad = remote.getByRole("button", {
        name: "Open new thread launchpad for FixtureRepo",
      });
      await openRemoteLaunchpad.click();
      const submittedPrompt = "Create a remote thread exactly once";
      await remote.getByRole("textbox", { name: "New thread" }).fill(submittedPrompt);
      await expect
        .poll(
          async () => await remote.evaluate(async ({ directoryKey, instanceId }) => {
            const api = (window as typeof window & {
              pwragent?: {
                ensureDirectoryLaunchpad?: (request: unknown) => Promise<{
                  launchpad: { prompt: string };
                }>;
              };
            }).pwragent;
            if (!api?.ensureDirectoryLaunchpad) return "missing-api";
            const response = await api.ensureDirectoryLaunchpad({
              federationTarget: {
                scope: "remote",
                instanceId,
              },
              directoryKey,
              directoryKind: "directory",
              directoryLabel: "FixtureRepo",
              directoryPath: "/remote/FixtureRepo",
            });
            return response.launchpad.prompt;
          }, {
            directoryKey: "directory:/remote/FixtureRepo",
            instanceId: gateway!.instanceId,
          }),
          { timeout: 15_000 },
        )
        .toBe(submittedPrompt);
      await remote.getByRole("button", { name: "Start thread" }).click();
      await expect
        .poll(
          () => gateway!.calls.filter(
            (call) => call.method === "materializeDirectoryLaunchpad",
          ).length,
          { timeout: 30_000 },
        )
        .toBe(1);
      await expect(
        remote.getByRole("heading", { level: 2, name: submittedPrompt }),
      ).toBeVisible({ timeout: 30_000 });

      await openRemoteLaunchpad.click();
      await expect(
        remote.getByTestId("composer-tiptap-input"),
      ).toHaveAttribute("data-value", "");

      // A child launchpad inherits the Kimi parent first. Switching it to
      // OpenAI and choosing a Codex environment must preserve that environment
      // through remote materialization, including the review-command path.
      await remote
        .getByRole("button", { name: "EnvironmentRepo, 1 thread to review" })
        .click();
      const remoteKimiParent = remote.getByRole("button", {
        name: "Remote Kimi parent",
      });
      await expect(remoteKimiParent).toBeVisible();
      await rightClickThreadRow(remote, "Remote Kimi parent");
      await remote
        .getByRole("menuitem", { name: "Sub-thread in Same Worktree" })
        .click();

      const childPrompt = remote.getByRole("textbox", { name: "New thread" });
      await expect(childPrompt).toBeVisible();
      const childSettings = remote.getByLabel("New thread settings");
      const childProvider = childSettings.getByRole("button", {
        name: /^Provider(?::|$)/,
        exact: true,
      });
      await expect(childProvider).toContainText("Kimi");
      await childProvider.click();
      await remote.getByRole("option", { name: "OpenAI", exact: true }).click();
      await expect(childProvider).toContainText("OpenAI");

      const childTools = remote.getByLabel("Composer tools");
      const childEnvironment = childTools.getByRole("button", {
        name: /^Environment(?::|$)/,
        exact: true,
      });
      await expect(childEnvironment).toBeVisible();
      await childEnvironment.click();
      await remote.getByRole("option", { name: "PwrAgent", exact: true }).click();
      await expect(childEnvironment).toContainText("PwrAgent");

      await childPrompt.fill("/review");
      await remote.getByRole("button", { name: "Start sub-thread" }).click();
      const reviewTarget = remote.getByRole("group", { name: "Review target" });
      await expect(reviewTarget).toBeVisible();
      await reviewTarget.getByRole("combobox", { name: "Base branch" }).click();
      await reviewTarget.getByRole("option", { name: "main", exact: true }).click();
      await reviewTarget.getByRole("button", { name: "Start review" }).click();

      await expect
        .poll(
          () => gateway!.calls.filter(
            (call) => call.method === "materializeDirectoryLaunchpad",
          ).length,
          { timeout: 30_000 },
        )
        .toBe(2);
      const childMaterializeCall = gateway.calls.filter(
        (call) => call.method === "materializeDirectoryLaunchpad",
      ).at(-1);
      expect(childMaterializeCall?.params).toMatchObject({
        parentThreadId: "remote-kimi-parent",
        reviewTarget: { type: "baseBranch", branch: "main" },
        launchpad: {
          backend: "codex",
          codexEnvironmentId: "environment",
          codexEnvironmentExecutionTarget: "local",
          directoryPath: ownerOnlyEnvironmentRepo,
        },
      });

      await remoteRowOne.click();
      const remoteReply = remote.getByRole("textbox", { name: "Reply" });
      const recoveryDraft = "Keep this draft while the gateway reconnects";
      await expect(remoteReply).toBeVisible();
      await remoteReply.fill(recoveryDraft);
      const sendButton = remote.getByRole("button", { name: "Send" });
      await expect(sendButton).toBeEnabled();

      // The gateway only ever served federation RPCs — no local PR
      // refresh or other local-only method leaked across the wire.
      expect(
        gateway.calls.map((call) => call.method),
      ).not.toContain("refreshThreadPullRequests");

      // Peer death: the window keeps its stale navigation and durable draft
      // visible. Remote writes are disabled, but the editor stays live so the
      // operator can inspect, copy, and revise text while reconnecting.
      await gateway.stop();
      await expect(
        remote.locator(".federation-disconnected-banner"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(remote.locator(".app-main")).toHaveClass(
        /app-main--federation-disconnected/,
      );
      await expect(
        remote.locator(".federation-disconnected-banner"),
      ).toContainText("Gateway is unreachable");
      await expect(
        window.locator(".federation-disconnected-banner"),
      ).toContainText("Gateway is unreachable");
      await expect(window.locator(".app-main")).toHaveClass(
        /app-main--federation-disconnected/,
      );
      await expect(
        remote.locator(".composer-tiptap-input__editor"),
      ).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
      await expect(remoteReply).toContainText(recoveryDraft);
      await expect(sendButton).toBeDisabled();
      await expect(remoteRowOne).toBeVisible();
      await expect(remoteCardOne).toHaveClass(/is-remote-offline/);
      await expect(locallyMountedRemoteRow).toBeVisible();
      await expect(locallyMountedRemoteCard).toHaveClass(/is-remote-offline/);

      // Recovery: the same identity returns on the same port; the client
      // reconnects on its own backoff and the window heals without a
      // reload — banner gone, remote threads back.
      await gateway.restart();
      await gateway.waitForNextConnection(90_000);
      await expect(
        remote.locator(".federation-disconnected-banner"),
      ).toHaveCount(0, { timeout: 60_000 });
      await expect(remote.locator(".app-main")).not.toHaveClass(
        /app-main--federation-disconnected/,
      );
      await expect(
        window.locator(".federation-disconnected-banner"),
      ).toHaveCount(0);
      await expect(window.locator(".app-main")).not.toHaveClass(
        /app-main--federation-disconnected/,
      );
      await expect(
        remote.locator(".thread-row__title", {
          hasText: "Remote gateway thread one",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(remoteRowOne).not.toHaveClass(/is-remote-offline/);
      await expect(locallyMountedRemoteRow).not.toHaveClass(/is-remote-offline/);
      await expect(remoteReply).toContainText(recoveryDraft);
      await expect(sendButton).toBeEnabled();
    } finally {
      await app?.close();
      await gateway?.close();
      await fixture.cleanup();
      await rm(ownerPtyCwd, { force: true, recursive: true });
    }
  });

  test("starts drafts on the peer's provider when the peer cannot run this machine's", async () => {
    test.setTimeout(240_000);

    let gateway: InProcessFederationGateway | undefined;
    const fixture = await createLocalControlFixture();
    let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      // The peer runs OpenAI only. Its Kimi parent stands in for a thread
      // whose provider the peer has since lost, as a Claude thread does on
      // a peer whose Claude Code sign-in lapsed.
      gateway = await startInProcessFederationGateway({
        instanceLabel: "E2E OpenAI-only Gateway",
        backendKinds: ["codex"],
        directories: [
          {
            key: "directory:/remote/ProviderRepo",
            label: "ProviderRepo",
            path: "/remote/ProviderRepo",
            threadIds: ["remote-kimi-parent"],
          },
        ],
        threads: [
          {
            id: "remote-kimi-parent",
            title: "Remote Kimi parent",
            updatedAt: 1_500,
            source: "acp:kimi",
            executionMode: "default",
            linkedDirectories: [
              {
                id: "/remote/ProviderRepo",
                label: "ProviderRepo",
                path: "/remote/ProviderRepo",
                worktreePath: "/remote/ProviderRepo",
                kind: "worktree",
              },
            ],
          },
        ],
      });

      // This machine runs Kimi Code too, and its new threads start on it.
      app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const { executablePath: fakeKimiPath } =
            await seedFakeKimiExecutable(homeRoot);
          const profile = path.join(homeRoot, ".pwragent", "profiles", "default");
          await mkdir(path.join(profile, "state"), { recursive: true });
          await writeFile(
            path.join(profile, "config.toml"),
            ["[acp_agents.kimi]", `cli_path = ${JSON.stringify(fakeKimiPath)}`, ""].join("\n"),
            "utf8",
          );
          const db = StateDb.open(path.join(profile, "state", "state.db"));
          try {
            await new SqliteOverlayStore(db).setLaunchpadDefaults({
              backend: "acp:kimi",
              executionMode: "default",
            });
          } finally {
            db.close();
          }
        },
      });
      const { electronApp, window } = app;
      await expect
        .poll(
          async () => await window.evaluate(async () => {
            const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
            const { backends } = await api.listBackends!({ includeUnavailable: true });
            return backends.some(
              (backend) => backend.kind === "acp:kimi" && backend.available,
            );
          }),
          { timeout: 60_000 },
        )
        .toBe(true);

      await window.getByRole("button", { name: "Open settings" }).click();
      await window
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Federation", exact: true })
        .click();
      await window.getByLabel("Import invite").fill(gateway.invite);
      await window.getByRole("button", { name: "Import invite" }).click();
      await gateway.waitForConnection(30_000);
      await expect(
        window
          .getByRole("region", { name: "Connection" })
          .getByText("Connected", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      const remoteWindowPromise = electronApp.waitForEvent("window");
      await window
        .getByRole("button", { name: "Browse remote threads" })
        .click();
      const remote = await remoteWindowPromise;
      await remote.waitForLoadState("domcontentloaded");
      await expect(
        remote.getByRole("button", { name: "Remote Kimi parent" }),
      ).toBeVisible({ timeout: 30_000 });

      const settings = remote.getByLabel("New thread settings");
      const provider = settings.getByRole("button", {
        name: /^Provider(?::|$)/,
        exact: true,
      });
      const ensureCalls = () => gateway!.calls
        .filter((call) => call.method === "ensureDirectoryLaunchpad")
        .map((call) => call.params as { directoryKey: string; preferredBackend?: string });
      // The provider the peer is told to start. The Provider control is no
      // evidence: it lists the peer's providers only, so it reads OpenAI
      // even over a draft that holds this machine's Kimi Code.
      const startedBackends = () => gateway!.calls
        .filter((call) => call.method === "materializeDirectoryLaunchpad")
        .map((call) => (call.params as { launchpad?: { backend?: string } }).launchpad?.backend);

      // A top-level draft names no provider, so this machine's Kimi Code
      // would fill it. The peer's provider list has no Kimi Code.
      await remote.getByRole("tab", { name: "directories" }).click();
      await remote
        .getByRole("button", { name: "Open new thread launchpad for ProviderRepo" })
        .click();
      const prompt = remote.getByRole("textbox", { name: "New thread" });
      await expect(prompt).toBeVisible();
      await expect(provider).toContainText("OpenAI", { timeout: 15_000 });
      await prompt.fill("Start on a provider the peer has");
      // Over this machine's Kimi Code the peer could not start the thread,
      // and send stayed disabled.
      const startThread = remote.getByRole("button", { name: "Start thread" });
      await expect(startThread).toBeEnabled();
      await startThread.click();
      await expect.poll(startedBackends, { timeout: 30_000 }).toEqual(["codex"]);

      // A sub-thread asks for its parent's Kimi Code and gets OpenAI too.
      const callsBeforeChild = ensureCalls().length;
      await rightClickThreadRow(remote, "Remote Kimi parent");
      await remote
        .getByRole("menuitem", { name: "Sub-thread in Same Worktree" })
        .click();
      await expect(provider).toContainText("OpenAI", { timeout: 15_000 });
      expect(ensureCalls().slice(callsBeforeChild)).toContainEqual(
        expect.objectContaining({ preferredBackend: "acp:kimi" }),
      );
      await prompt.fill("Start the child on a provider the peer has");
      const startChild = remote.getByRole("button", { name: "Start sub-thread" });
      await expect(startChild).toBeEnabled();
      await startChild.click();
      await expect
        .poll(startedBackends, { timeout: 30_000 })
        .toEqual(["codex", "codex"]);
    } finally {
      await app?.close();
      await gateway?.close();
      await fixture.cleanup();
    }
  });

  test("keeps a remote draft apart from this machine's draft for the same directory", async () => {
    test.setTimeout(180_000);

    let gateway: InProcessFederationGateway | undefined;
    const fixture = await createLocalControlFixture();
    // Two Macs with one home layout: the peer's project lives at the path
    // this machine's project does, so both use one directory key.
    const sharedPath = await mkdtemp(path.join(os.tmpdir(), "pwragent-shared-layout-"));
    const directoryKey = `directory:${sharedPath}`;
    let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      gateway = await startInProcessFederationGateway({
        instanceLabel: "E2E Shared Layout Gateway",
        directories: [
          {
            key: directoryKey,
            label: "SharedRepo",
            path: sharedPath,
            threadIds: ["remote-shared-thread"],
          },
        ],
        threads: [
          {
            id: "remote-shared-thread",
            title: "Remote shared thread",
            updatedAt: 1_500,
            source: "codex",
            executionMode: "default",
            linkedDirectories: [
              {
                id: sharedPath,
                label: "SharedRepo",
                path: sharedPath,
                worktreePath: sharedPath,
                kind: "local",
              },
            ],
          },
        ],
      });
      app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
        secretStorage: "memory",
      });
      const { electronApp, window } = app;

      await window.getByRole("button", { name: "Open settings" }).click();
      await window
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Federation", exact: true })
        .click();
      await window.getByLabel("Import invite").fill(gateway.invite);
      await window.getByRole("button", { name: "Import invite" }).click();
      await gateway.waitForConnection(30_000);
      await expect(
        window
          .getByRole("region", { name: "Connection" })
          .getByText("Connected", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });

      const remoteWindowPromise = electronApp.waitForEvent("window");
      await window
        .getByRole("button", { name: "Browse remote threads" })
        .click();
      const remote = await remoteWindowPromise;
      await remote.waitForLoadState("domcontentloaded");
      await expect(
        remote.getByRole("button", { name: "Remote shared thread" }),
      ).toBeVisible({ timeout: 30_000 });

      const draftRequest = {
        directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "SharedRepo",
        directoryPath: sharedPath,
      };
      const remoteDraft = async () => await remote.evaluate(async ({ request, instanceId }) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        const response = await api.ensureDirectoryLaunchpad!({
          ...request,
          federationTarget: { scope: "remote", instanceId },
        });
        return { directoryKey: response.launchpad.directoryKey, prompt: response.launchpad.prompt };
      }, { request: draftRequest, instanceId: gateway!.instanceId });
      const localDraft = async () => await window.evaluate(async (request) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        return (await api.ensureDirectoryLaunchpad!(request)).launchpad.prompt;
      }, draftRequest);

      const peerText = "Draft for the peer's SharedRepo";
      await remote.getByRole("tab", { name: "directories" }).click();
      await remote
        .getByRole("button", { name: "Open new thread launchpad for SharedRepo" })
        .click();
      await remote.getByRole("textbox", { name: "New thread" }).fill(peerText);
      // The remote window still speaks the owner's key.
      await expect
        .poll(remoteDraft, { timeout: 15_000 })
        .toEqual({ directoryKey, prompt: peerText });

      // This machine's draft for the same key holds none of it.
      expect(await localDraft()).toBe("");
      const localText = "Draft for this machine's SharedRepo";
      await window.evaluate(async ({ key, prompt }) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        await api.updateDirectoryLaunchpad!({ directoryKey: key, patch: { prompt } });
      }, { key: directoryKey, prompt: localText });

      expect(await remoteDraft()).toEqual({ directoryKey, prompt: peerText });
      expect(await localDraft()).toBe(localText);
    } finally {
      await app?.close();
      await gateway?.close();
      await fixture.cleanup();
      await rm(sharedPath, { recursive: true, force: true });
    }
  });

  test("keeps a cross-instance child attached through restart, reconnect, unlink, and archive", async () => {
    test.skip(
      process.platform !== "darwin",
      "The full process-restart lifecycle targets the macOS VM reproduction; cross-platform federation transport remains covered above.",
    );
    test.setTimeout(300_000);

    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-federation-child-lifecycle-"),
    );
    const ownerRepo = path.join(fixtureRoot, "owner-repo");
    const viewerRepo = path.join(fixtureRoot, "viewer-repo");
    const federationPort = await reserveLoopbackPort();
    const ownerIdentity = generateFederationIdentityKeyPair();
    const ownerNoiseIdentity = generateFederationNoiseStaticKeyPair();
    const viewerIdentity = generateFederationIdentityKeyPair();
    const viewerNoiseIdentity = generateFederationNoiseStaticKeyPair();

    await seedFixtureGitRepo({
      repoDir: ownerRepo,
      environmentSetupScript: ":",
    });
    await seedFixtureGitRepo({
      repoDir: viewerRepo,
      environmentSetupScript: ":",
    });

    let owner: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    let viewer: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    try {
      owner = await launchElectronApp({
        requiresReplayDriver: false,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const { executablePath: fakeKimiPath } =
            await seedFakeKimiExecutable(homeRoot);
          const { executablePath: fakeCodexPath } =
            await seedFakeCodexExecutable({
              homeRoot,
              requestLogPath: path.join(fixtureRoot, "owner-codex.jsonl"),
              launchMarkerPath: path.join(fixtureRoot, "owner-codex.launched"),
            });
          await seedInstalledKimiParent({
            directoryPath: ownerRepo,
            homeRoot,
            fakeKimiPath,
          });
          const configPath = path.join(
            homeRoot,
            ".pwragent",
            "profiles",
            "default",
            "config.toml",
          );
          await mkdir(path.dirname(configPath), { recursive: true });
          await writeFile(
            configPath,
            buildFakeAgentConfigToml({
              fakeKimiPath,
              fakeCodexPath,
              extraToml: [
                "[federation]",
                'mode = "gateway"',
                'instance_label = "Child Lifecycle Owner"',
                'listen_host = "127.0.0.1"',
                `listen_port = ${federationPort}`,
                `public_url = "ws://127.0.0.1:${federationPort}"`,
                "",
              ].join("\n"),
            }),
            "utf8",
          );
        },
      });
      await restoreE2eFederationIdentity({
        identityPrivateKeyPem: ownerIdentity.privateKeyPem,
        noiseStaticPrivateKeyBase64: ownerNoiseIdentity.privateKeyBase64,
        page: owner.window,
        restartMode: "gateway",
      });

      const invite = await owner.window.evaluate(async () => {
        const api = (window as typeof window & {
          pwragent?: {
            generateFederationInvite?: () => Promise<{ invite: string }>;
          };
        }).pwragent;
        if (!api?.generateFederationInvite) {
          throw new Error("Owner invite API is unavailable");
        }
        return (await api.generateFederationInvite()).invite;
      });

      viewer = await launchElectronApp({
        requiresReplayDriver: false,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const { executablePath: fakeKimiPath } =
            await seedFakeKimiExecutable(homeRoot);
          const { executablePath: fakeCodexPath } =
            await seedFakeCodexExecutable({
              homeRoot,
              requestLogPath: path.join(fixtureRoot, "viewer-codex.jsonl"),
              launchMarkerPath: path.join(fixtureRoot, "viewer-codex.launched"),
            });
          await seedInstalledKimiParent({
            directoryPath: viewerRepo,
            homeRoot,
            fakeKimiPath,
            sessionId: "viewer-pin-anchor",
            title: "Viewer pin anchor",
          });
          const configPath = path.join(
            homeRoot,
            ".pwragent",
            "profiles",
            "default",
            "config.toml",
          );
          await mkdir(path.dirname(configPath), { recursive: true });
          await writeFile(
            configPath,
            buildFakeAgentConfigToml({ fakeKimiPath, fakeCodexPath }),
            "utf8",
          );
        },
      });
      await restoreE2eFederationIdentity({
        identityPrivateKeyPem: viewerIdentity.privateKeyPem,
        noiseStaticPrivateKeyBase64: viewerNoiseIdentity.privateKeyBase64,
        page: viewer.window,
      });
      await viewer.window.waitForTimeout(1_000);
      await viewer.window.evaluate(async (encodedInvite) => {
        const api = (window as typeof window & {
          pwragent?: {
            importFederationInvite?: (request: { invite: string }) => Promise<unknown>;
          };
        }).pwragent;
        if (!api?.importFederationInvite) {
          throw new Error("Viewer invite API is unavailable");
        }
        await api.importFederationInvite({ invite: encodedInvite });
      }, invite);

      await expect
        .poll(
          async () => await viewer!.window.evaluate(async () => {
            const api = (window as typeof window & {
              pwragent?: {
                readFederationHealth?: () => Promise<{
                  health: { instanceId?: string; status?: string };
                }>;
              };
            }).pwragent;
            const health = (await api?.readFederationHealth?.())?.health;
            return health?.status === "connected" ? health.instanceId : undefined;
          }),
          { timeout: 30_000 },
        )
        .toBeTruthy();

      const ownerInstanceId = await owner.window.evaluate(async () => {
        const api = (window as typeof window & {
          pwragent?: {
            readFederationHealth?: () => Promise<{
              health: { instanceId?: string };
            }>;
          };
        }).pwragent;
        return (await api?.readFederationHealth?.())?.health.instanceId;
      });
      const viewerInstanceId = await viewer.window.evaluate(async () => {
        const api = (window as typeof window & {
          pwragent?: {
            readFederationHealth?: () => Promise<{
              health: { instanceId?: string };
            }>;
          };
        }).pwragent;
        return (await api?.readFederationHealth?.())?.health.instanceId;
      });
      expect(ownerInstanceId).toBeTruthy();
      expect(viewerInstanceId).toBeTruthy();

      const viewerDirectoryKey = await viewer.window.evaluate(async (directoryPath) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar",
          query: { kind: "directory-index", paths: [directoryPath] },
        });
        const directory = page.directories?.find((candidate) => candidate.path === directoryPath);
        if (!directory) {
          throw new Error(`Viewer directory was not materialized: ${directoryPath}`);
        }
        await api.setThreadPin!({
          backend: "acp:kimi",
          threadId: "viewer-pin-anchor",
          pinnedRank: "1024",
        });
        await api.setDirectoryThreadsCollapsed!({
          directoryKey: directory.key,
          collapsed: true,
        });
        return directory.key;
      }, viewerRepo);
      expect(viewerDirectoryKey).toBeTruthy();

      const child = await owner.window.evaluate(
        async ({ directoryPath, parentInstanceId, targetInstanceId }) => {
          const api = (window as typeof window & {
            pwragent?: {
              materializeDirectoryLaunchpad?: (request: unknown) => Promise<{
                backend: string;
                threadId: string;
              }>;
            };
          }).pwragent;
          if (!api?.materializeDirectoryLaunchpad) {
            throw new Error("Owner materialization API is unavailable");
          }
          const now = Date.now();
          return await api.materializeDirectoryLaunchpad({
            directoryKey: "subthread:acp:kimi:federated-kimi-parent:same-worktree",
            federationTarget: {
              scope: "remote",
              instanceId: targetInstanceId,
            },
            parentThreadId: "federated-kimi-parent",
            parentThreadBackend: "acp:kimi",
            parentThreadInstanceId: parentInstanceId,
            launchpad: {
              directoryKey: "subthread:acp:kimi:federated-kimi-parent:same-worktree",
              directoryKind: "directory",
              directoryLabel: "viewer-repo",
              directoryPath,
              backend: "acp:kimi",
              executionMode: "default",
              prompt: "",
              workMode: "local",
              createdAt: now,
              updatedAt: now,
            },
          });
        },
        {
          directoryPath: viewerRepo,
          parentInstanceId: ownerInstanceId!,
          targetInstanceId: viewerInstanceId!,
        },
      );

      const readViewerRelationship = async () =>
        await viewer!.window.evaluate(
          async ({ childThreadId, parentInstanceId }) => {
            const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
            const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", inventory: "viewer",
              query: { kind: "exact", identities: [
                { backend: "acp:kimi", threadId: childThreadId },
                { backend: "acp:kimi", threadId: "federated-kimi-parent", ownerInstanceId: parentInstanceId },
              ] },
            });
            const childThread = page.entries.find(({ row }) => row.id === childThreadId && !row.ref.ownerInstanceId)?.row;
            const parentThread = page.entries.find(({ row }) => row.id === "federated-kimi-parent" && row.ref.ownerInstanceId === parentInstanceId)?.row;
            return { childThread, parentThread };
          },
          {
            childThreadId: child.threadId,
            parentInstanceId: ownerInstanceId!,
          },
        );

      await expect
        .poll(async () => JSON.stringify(await readViewerRelationship()))
        .toContain(`"parentThreadInstanceId":"${ownerInstanceId}"`);
      let relationship = await readViewerRelationship();
      expect(relationship.childThread).toMatchObject({
        parentThreadBackend: "acp:kimi",
        parentThreadId: "federated-kimi-parent",
        parentThreadInstanceId: ownerInstanceId,
      });
      expect(relationship.parentThread).toMatchObject({ pinnedRank: expect.any(String) });

      const viewerHomeRoot = viewer.homeRoot;
      await viewer.closeApplication();
      // The E2E memory secret store intentionally does not survive process
      // exit. Keep federation stopped during boot so a temporary regenerated
      // identity cannot be rejected before the original keys are restored.
      disableE2eFederationBeforeRelaunch(viewerHomeRoot);
      viewer = await launchElectronApp({
        homeRoot: viewerHomeRoot,
        requiresReplayDriver: false,
        secretStorage: "memory",
      });
      await restoreE2eFederationIdentity({
        identityPrivateKeyPem: viewerIdentity.privateKeyPem,
        noiseStaticPrivateKeyBase64: viewerNoiseIdentity.privateKeyBase64,
        page: viewer.window,
        restartMode: "client",
      });
      await expect
        .poll(
          async () => await viewer!.window.evaluate(async () => {
            const api = (window as typeof window & {
              pwragent?: {
                readFederationHealth?: () => Promise<{
                  health: { status?: string };
                }>;
              };
            }).pwragent;
            return (await api?.readFederationHealth?.())?.health.status;
          }),
          { timeout: 60_000 },
        )
        .toBe("connected");
      await expect
        .poll(
          async () => (await readViewerRelationship()).childThread
            ?.parentThreadInstanceId,
          { timeout: 60_000 },
        )
        .toBe(ownerInstanceId);
      relationship = await readViewerRelationship();
      expect(relationship.parentThread).toMatchObject({ pinnedRank: expect.any(String) });

      const ownerHomeRoot = owner.homeRoot;
      await owner.closeApplication();
      disableE2eFederationBeforeRelaunch(ownerHomeRoot);
      const remoteParentRow = viewer.window.locator(".thread-row", {
        has: viewer.window.locator(".thread-row__title", {
          hasText: "Remote Kimi parent",
        }),
      });
      await expect(remoteParentRow).toHaveClass(/is-remote-offline/, {
        timeout: 60_000,
      });

      owner = await launchElectronApp({
        homeRoot: ownerHomeRoot,
        requiresReplayDriver: false,
        secretStorage: "memory",
      });
      await restoreE2eFederationIdentity({
        identityPrivateKeyPem: ownerIdentity.privateKeyPem,
        noiseStaticPrivateKeyBase64: ownerNoiseIdentity.privateKeyBase64,
        page: owner.window,
        restartMode: "gateway",
      });
      await expect(remoteParentRow).not.toHaveClass(/is-remote-offline/, {
        timeout: 90_000,
      });

      // Anchored regex, not `exact: true`: this test pins the parent, and
      // a pinned row's accessible name is "<title>, pinned" — while the
      // anchor still excludes the row's kebab/sub-thread labels that
      // merely contain the title.
      await rightClickThreadRow(viewer.window, /^Remote Kimi parent(, pinned)?$/);
      await expect(
        viewer.window.getByRole("menuitem", { name: "Rename Thread" }),
      ).toBeVisible();
      await expect(
        viewer.window.getByRole("menuitem", { name: "Mark Unread" }),
      ).toBeVisible();
      await expect(
        viewer.window.getByRole("menuitem", {
          name: /Archive Thread Only/,
        }),
      ).toBeVisible();
      await viewer.window.keyboard.press("Escape");

      relationship = await readViewerRelationship();
      const childTitle = relationship.childThread?.title;
      expect(childTitle).toBeTruthy();
      await rightClickThreadRow(viewer.window, childTitle!, { exact: true });
      await viewer.window.getByRole("menuitem", { name: "Unlink from Parent" }).click();
      await expect
        .poll(async () => {
          const child = (await readViewerRelationship()).childThread;
          return {
            pinnedRank: child?.pinnedRank,
            parentThreadId: child?.parentThreadId,
            parentThreadInstanceId: child?.parentThreadInstanceId,
          };
        })
        .toEqual({
          pinnedRank: expect.any(String),
          parentThreadId: undefined,
          parentThreadInstanceId: undefined,
        });

      // Unlink above must not wait for provider listing; on CI it routinely
      // runs while the relaunched viewer is still checking. Archive must wait.
      // It discovers the viewer's own children of this parent, and an
      // unlisted child would be left behind, so it requires complete
      // coverage. Startup discovery spawns each provider CLI.
      await expect
        .poll(
          async () => await viewer!.window.evaluate(async (parentInstanceId) => {
            const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
            const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", inventory: "viewer",
              query: { kind: "exact", identities: [
                { backend: "acp:kimi", threadId: "federated-kimi-parent", ownerInstanceId: parentInstanceId },
              ] },
            });
            return page.coverage.state;
          }, ownerInstanceId!),
          { timeout: 60_000 },
        )
        .toBe("complete");
      await rightClickThreadRow(viewer.window, /^Remote Kimi parent(, pinned)?$/);
      await viewer.window.getByRole("menuitem", {
        name: "Archive Thread",
        exact: true,
      }).click();
      await expect
        .poll(async () => (await readViewerRelationship()).parentThread)
        .toBeUndefined();
    } finally {
      try {
        await viewer?.close();
      } finally {
        try {
          await owner?.close();
        } finally {
          await rm(fixtureRoot, { force: true, recursive: true });
        }
      }
    }
  });

  test("preserves a Codex environment when a Kimi child is born through a remote viewer", async ({ browserName: _browserName }, testInfo) => {
    test.setTimeout(300_000);

    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-federation-environment-owner-"),
    );
    const sourceRepo = path.join(fixtureRoot, "source");
    const fixtureRepo = path.join(
      fixtureRoot,
      ".pwragent",
      "worktrees",
      "federation-environment-repro",
      "FixtureRepo",
    );
    const setupMarkerPath = path.join(
      fixtureRepo,
      FEDERATION_CHILD_ENVIRONMENT_MARKER,
    );
    const federationPort = await reserveLoopbackPort();

    await mkdir(sourceRepo, { recursive: true });
    execFileSync("git", ["init"], { cwd: sourceRepo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], {
      cwd: sourceRepo,
      stdio: "ignore",
    });
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
        "Seed federation source repo",
      ],
      { cwd: sourceRepo, stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["worktree", "add", "-b", "federation-environment-repro", fixtureRepo, "main"],
      { cwd: sourceRepo, stdio: "ignore" },
    );
    await seedFixtureGitRepo({
      repoDir: fixtureRepo,
      // Environment setup uses PowerShell on Windows, not Git Bash.
      environmentSetupScript: process.platform === "win32"
        ? `New-Item -ItemType File -Force -Path '${FEDERATION_CHILD_ENVIRONMENT_MARKER}' | Out-Null`
        : `touch ${FEDERATION_CHILD_ENVIRONMENT_MARKER}`,
      commitMessage: "Seed federation environment fixture",
      initializeGit: false,
    });

    const protocolDir = path.join(fixtureRoot, "protocol");
    const requestLogPath = path.join(protocolDir, "fake-codex.protocol.jsonl");
    const launchMarkerPath = path.join(protocolDir, "fake-codex.launched");
    const viewerRequestLogPath = path.join(
      protocolDir,
      "viewer-fake-codex.protocol.jsonl",
    );
    const viewerLaunchMarkerPath = path.join(
      protocolDir,
      "viewer-fake-codex.launched",
    );
    await mkdir(protocolDir, { recursive: true });

    const navigationDiagnostics: string[] = [];
    const recordDiagnostic = (message: string) => {
      navigationDiagnostics.push(message.slice(0, 4000));
      if (navigationDiagnostics.length > 100) navigationDiagnostics.shift();
    };
    let owner: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    let viewer: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    let completed = false;
    try {
      // Real owner: executable-backed Kimi + Codex via production settings.
      // No PWRAGENT_REPLAY_FIXTURE_PATH — Codex discovery spawns fake-codex.
      owner = await launchElectronApp({
        requiresReplayDriver: false,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const { executablePath: fakeKimiPath } =
            await seedFakeKimiExecutable(homeRoot);
          const { executablePath: fakeCodexPath } =
            await seedFakeCodexExecutable({
              homeRoot,
              requestLogPath,
              launchMarkerPath,
            });
          await seedInstalledKimiParent({
            directoryPath: fixtureRepo,
            homeRoot,
            fakeKimiPath,
          });
          const configPath = path.join(
            homeRoot,
            ".pwragent",
            "profiles",
            "default",
            "config.toml",
          );
          await mkdir(path.dirname(configPath), { recursive: true });
          await writeFile(
            configPath,
            buildFakeAgentConfigToml({
              fakeKimiPath,
              fakeCodexPath,
              extraToml: [
                "[federation]",
                'mode = "gateway"',
                'instance_label = "Federation Environment Owner"',
                'listen_host = "127.0.0.1"',
                `listen_port = ${federationPort}`,
                `public_url = "ws://127.0.0.1:${federationPort}"`,
                "",
              ].join("\n"),
            }),
            "utf8",
          );
        },
      });

      await expect
        .poll(
          async () => await owner!.window.evaluate(async () => {
            const api = (window as typeof window & {
              pwragent?: {
                listBackends?: () => Promise<{
                  backends: Array<{ available: boolean; kind: string }>;
                }>;
              };
            }).pwragent;
            const response = await api?.listBackends?.();
            const kimiReady = response?.backends.some(
              (backend) => backend.kind === "acp:kimi" && backend.available,
            ) ?? false;
            const codexReady = response?.backends.some(
              (backend) => backend.kind === "codex" && backend.available,
            ) ?? false;
            return kimiReady && codexReady;
          }),
          { timeout: 60_000 },
        )
        .toBe(true);

      const parent = {
        backend: "acp:kimi",
        threadId: "federated-kimi-parent",
      };

      const invite = await owner.window.evaluate(async () => {
        const api = (window as typeof window & {
          pwragent?: {
            generateFederationInvite?: () => Promise<{ invite: string }>;
          };
        }).pwragent;
        if (!api?.generateFederationInvite) {
          throw new Error("Owner invite API is unavailable");
        }
        return (await api.generateFederationInvite()).invite;
      });

      // The viewer has its own Codex, as an operator's machine does, with a
      // catalog the owner does not share. Without one, discovery would find
      // whatever Codex the host has installed (none on CI's runner), and the
      // remote child would take a different path on each machine.
      viewer = await launchElectronApp({
        requiresReplayDriver: false,
        secretStorage: "memory",
        preLaunchHook: async (homeRoot) => {
          const { executablePath: viewerFakeCodexPath } =
            await seedFakeCodexExecutable({
              homeRoot,
              requestLogPath: viewerRequestLogPath,
              launchMarkerPath: viewerLaunchMarkerPath,
              models: [VIEWER_ONLY_CODEX_MODEL],
            });
          const configPath = path.join(
            homeRoot,
            ".pwragent",
            "profiles",
            "default",
            "config.toml",
          );
          await mkdir(path.dirname(configPath), { recursive: true });
          await writeFile(
            configPath,
            `[models.codex]\npath = ${JSON.stringify(viewerFakeCodexPath)}\n`,
            "utf8",
          );
        },
      });
      await expect
        .poll(
          async () => await viewer!.window.evaluate(async () => {
            const api = (window as typeof window & {
              pwragent?: {
                readFederationHealth?: () => Promise<{
                  health: { enabled: boolean };
                }>;
              };
            }).pwragent;
            return (await api?.readFederationHealth?.())?.health.enabled;
          }),
          { timeout: 30_000 },
        )
        .toBe(false);
      await expect
        .poll(
          async () => await viewer!.window.evaluate(async () => {
            const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
            const { backends } = await api.listBackends!({ includeUnavailable: true });
            const codex = backends.find((backend) => backend.kind === "codex");
            return codex?.available
              ? codex.launchpadOptions?.models?.map((model) => model.id)
              : undefined;
          }),
          { timeout: 30_000 },
        )
        .toEqual([VIEWER_ONLY_CODEX_MODEL]);
      // The renderer can become ready while the fire-and-forget federation
      // startup restart is still unwinding. Importing during that narrow boot
      // window coalesces with the disabled-mode restart instead of dialing the
      // newly enrolled gateway, which is not representative of a viewer the
      // operator is already using.
      await viewer.window.waitForTimeout(1_000);
      const enrollment = await viewer.window.evaluate(async (encodedInvite) => {
        const api = (window as typeof window & {
          pwragent?: {
            importFederationInvite?: (request: { invite: string }) => Promise<{
              gatewayInstanceId: string;
            }>;
          };
        }).pwragent;
        if (!api?.importFederationInvite) {
          throw new Error("Viewer invite API is unavailable");
        }
        return await api.importFederationInvite({ invite: encodedInvite });
      }, invite);

      await expect
        .poll(
          async () => await viewer!.window.evaluate(async () => {
            const api = (window as typeof window & {
              pwragent?: {
                readFederationHealth?: () => Promise<{
                  health: { status?: string };
                }>;
              };
            }).pwragent;
            return JSON.stringify((await api?.readFederationHealth?.())?.health);
          }),
          { timeout: 30_000 },
        )
        .toContain('"status":"connected"');

      for (const [name, instance] of [["owner", owner], ["viewer", viewer]] as const) {
        instance.electronApp.process().stderr?.on("data", (data) => recordDiagnostic(`${name}: ${String(data)}`));
      }
      const remoteWindowPromise = viewer.electronApp.waitForEvent("window");
      await viewer.window.evaluate(async (instanceId) => {
        const api = (window as typeof window & {
          pwragent?: {
            openFederationWindow?: (request: unknown) => Promise<unknown>;
          };
        }).pwragent;
        if (!api?.openFederationWindow) {
          throw new Error("Viewer remote-window API is unavailable");
        }
        await api.openFederationWindow({
          target: { scope: "remote", instanceId },
        });
      }, enrollment.gatewayInstanceId);
      const remote = await remoteWindowPromise;
      remote.on("console", (message) => recordDiagnostic(`renderer: ${message.text()}`));
      await remote.waitForLoadState("domcontentloaded");

      const remoteKimiParent = remote.getByRole("button", {
        name: "Remote Kimi parent",
        exact: true,
      });
      await expect(remoteKimiParent).toBeVisible({ timeout: 30_000 });
      await rightClickThreadRow(remote, "Remote Kimi parent");
      await remote
        .getByRole("menuitem", { name: "Sub-thread in Same Worktree" })
        .click();

      const childSettings = remote.getByLabel("New thread settings");
      const childProvider = childSettings.getByRole("button", {
        name: /^Provider(?::|$)/,
        exact: true,
      });
      await expect(childProvider).toContainText("Kimi");
      await childProvider.click();
      await remote.getByRole("option", { name: "OpenAI", exact: true }).click();
      await expect(childProvider).toContainText("OpenAI");

      const childAccessMode = childSettings.getByLabel(/^Access mode(?::|$)/);
      if (await childAccessMode.getAttribute("data-value") !== "full-access") {
        await childAccessMode.click();
        await remote.getByRole("option", { name: "Full Access" }).click();
        await remote
          .getByRole("dialog", { name: "Enable Full Access?" })
          .getByRole("button", { name: "I Understand and Accept the Risks" })
          .click();
      }
      await expect(childAccessMode).toHaveAttribute("data-value", "full-access");

      const childEnvironment = remote
        .getByLabel("Composer tools")
        .getByRole("button", { name: /^Environment(?::|$)/, exact: true });
      await expect(childEnvironment).toBeVisible();
      await childEnvironment.click();
      await remote.getByRole("option", { name: "PwrAgent", exact: true }).click();
      await expect(childEnvironment).toContainText("PwrAgent");

      await remote.getByRole("textbox", { name: "New thread" }).fill("/review");
      await remote.getByRole("button", { name: "Start sub-thread" }).click();
      const reviewTarget = remote.getByRole("group", { name: "Review target" });
      await expect(reviewTarget).toBeVisible();
      await reviewTarget.getByRole("combobox", { name: "Base branch" }).click();
      await reviewTarget.getByRole("option", { name: "main", exact: true }).click();
      await reviewTarget.getByRole("button", { name: "Start review" }).click();

      // Owner retains environmentId=environment on the materialized child.
      let ownerChildEnvironment:
        | { environmentId: string; setupDurationMs?: number; setupOutput?: string; setupStatus?: string }
        | undefined;
      await expect
        .poll(
          async () => {
            ownerChildEnvironment = await owner!.window.evaluate(
              async ({ parentThreadId }) => {
                const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
                const children = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar",
                  query: { kind: "children", parent: { backend: "acp:kimi", threadId: parentThreadId } }, pageSize: 10,
                });
                const child = children.entries.find(({ row }) => row.source === "codex")?.row;
                if (!child) return undefined;
                const detail = await api.getNavigationSelectedDetail!({ protocol: 2, ref: child.ref });
                const runtime = detail.thread?.codexEnvironmentRuntime;
                return runtime?.environmentId ? {
                  environmentId: runtime.environmentId,
                  setupDurationMs: runtime.setupDurationMs,
                  setupOutput: runtime.setupOutput?.slice(-2_000),
                  setupStatus: runtime.setupStatus,
                } : undefined;
              },
              { parentThreadId: parent.threadId },
            );
            return ownerChildEnvironment?.environmentId;
          },
          { timeout: 60_000 },
        )
        .toBe("environment");
      // A failed or timed-out setup still records the environment on the
      // child, so name the owner's setup outcome before looking for its marker.
      expect(ownerChildEnvironment, "owner environment setup outcome").toMatchObject({
        setupStatus: "completed",
      });

      // Setup marker proves environment setup actually ran on the owner worktree.
      await expect
        .poll(() => existsSync(setupMarkerPath), { timeout: 30_000 })
        .toBe(true);

      // Fake Codex must have been launched through production discovery.
      await expect
        .poll(() => {
          try {
            const raw = statSync(launchMarkerPath);
            return raw.size > 0;
          } catch {
            return false;
          }
        }, { timeout: 30_000 })
        .toBe(true);

      // Durable protocol capture: thread/start saw the setup marker.
      await expect
        .poll(async () => {
          const entries = await readFakeCodexRequestLog(requestLogPath);
          return findAllFakeCodexRequests(entries, "thread/start").length;
        }, { timeout: 30_000 })
        .toBeGreaterThan(0);

      let protocol = await readFakeCodexRequestLog(requestLogPath);
      let threadStart = findFakeCodexRequest(protocol, "thread/start");
      expect(threadStart).toBeTruthy();

      // Exact failure assertion: when fake Codex received thread/start, the
      // environment setup marker already existed in the requested cwd.
      expect(threadStart!.setupMarkerPresent).toBe(true);

      // Filesystem clock corroboration (allow small FS timestamp skew).
      const setupMtimeMs = statSync(setupMarkerPath).mtimeMs;
      expect(setupMtimeMs).toBeLessThanOrEqual(threadStart!.at + 5_000);

      // Starting a native review continues asynchronously after child
      // materialization. Wait for the durable request instead of assuming it
      // has arrived as soon as thread/start is observable on a slower VM.
      await expect
        .poll(async () => {
          const entries = await readFakeCodexRequestLog(requestLogPath);
          return findAllFakeCodexRequests(entries, "review/start").length;
        }, { timeout: 30_000 })
        .toBeGreaterThan(0);

      protocol = await readFakeCodexRequestLog(requestLogPath);
      const initialize = findFakeCodexRequest(protocol, "initialize");
      threadStart = findFakeCodexRequest(protocol, "thread/start");
      const reviewStart = findFakeCodexRequest(protocol, "review/start");
      expect(initialize).toBeTruthy();
      expect(threadStart).toBeTruthy();
      expect(reviewStart).toBeTruthy();
      expect(initialize!.at).toBeLessThanOrEqual(threadStart!.at);
      expect(threadStart!.at).toBeLessThanOrEqual(reviewStart!.at);
      // The viewer composed the child against its own Codex catalog. The
      // owner runs it, so the owner's catalog chooses the model.
      expect(threadStart!.params).toMatchObject({ model: "gpt-5.5" });
      expect(
        findAllFakeCodexRequests(
          await readFakeCodexRequestLog(viewerRequestLogPath),
          "review/start",
        ),
      ).toEqual([]);
      completed = true;
    } finally {
      // testInfo.status still reads "passed" while the body unwinds, so it
      // cannot tell this block that an assertion failed.
      if (!completed) await testInfo.attach("navigation-diagnostics", {
        body: navigationDiagnostics.join("\n"), contentType: "text/plain",
      });
      if (existsSync(requestLogPath)) {
        await testInfo.attach("fake-codex-protocol", {
          path: requestLogPath,
          contentType: "application/x-ndjson",
        });
      }
      await viewer?.close();
      await owner?.close();
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});
