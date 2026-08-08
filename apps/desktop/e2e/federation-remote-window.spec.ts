import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
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

async function createLocalControlFixture(): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
}> {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-federation-e2e-"),
  );
  const fixturePath = path.join(rootDir, "federation-local.fixture.json");
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
              id: "local-thread-1",
              title: "Local control thread",
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
                text: "Local thread is ready.",
              },
            ],
            messages: [
              {
                id: "local-message-1",
                role: "assistant",
                text: "Local thread is ready.",
              },
            ],
            lastAssistantMessage: "Local thread is ready.",
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        },
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
  test("enrolls, browses remote threads, pins on the owner, and hides local-only chrome", async () => {
    test.setTimeout(300_000);

    let gateway: InProcessFederationGateway | undefined;
    const fixture = await createLocalControlFixture();
    // The OWNER-side worktree: the remote shell's cwd lives in the test
    // process, so a marker file appearing here proves where the PTY ran.
    const ownerPtyCwd = await mkdtemp(
      path.join(os.tmpdir(), "pwragent-federation-e2e-pty-"),
    );
    const fixtureRepo = path.join(ownerPtyCwd, "FixtureRepo");
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
            key: `directory:${fixtureRepo}`,
            label: "EnvironmentRepo",
            path: fixtureRepo,
            threadIds: ["remote-kimi-parent"],
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
                id: fixtureRepo,
                label: "EnvironmentRepo",
                path: fixtureRepo,
                worktreePath: fixtureRepo,
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
        .getByRole("button", { name: "Federation" })
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
      await expect
        .poll(async () =>
          (
            await electronApp.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().map((win) => win.getTitle()),
            )
          ).some((title) => /^PwrAgent - ./.test(title)),
        )
        .toBe(true);

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
      });
      // Row state (selection, offline dim) lives on the CARD; the button is
      // only the title line inside it, because the chip flow beside it
      // carries buttons of its own (see ThreadRow).
      const locallyMountedRemoteCard = window.locator(".thread-row", {
        has: locallyMountedRemoteRow,
      });
      await expect(locallyMountedRemoteRow).toBeVisible({ timeout: 30_000 });
      await expect(locallyMountedRemoteCard).not.toHaveClass(/is-remote-offline/);

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
      const remoteRowOne = remote.getByRole("button", {
        name: "Remote gateway thread one",
      });
      const remoteCardOne = remote.locator(".thread-row", {
        has: remoteRowOne,
      });
      await remoteRowOne.click();
      await expect(
        remote.getByText(/Remote transcript for Remote gateway thread one/),
      ).toBeVisible({ timeout: 30_000 });
      const terminalToggle = remote.locator(".thread-header__terminal-toggle");
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
      await remote.getByRole("button", { name: "Close terminal" }).click();
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
      await remoteRowOne.click({ button: "right" });
      await remote.getByRole("menuitem", { name: "Pin Thread" }).click();
      await expect
        .poll(() => gateway!.pinnedRankByThreadId.get("remote-thread-1") ?? null, {
          timeout: 15_000,
        })
        .not.toBeNull();
      const pinCall = gateway.calls.find(
        (call) => call.method === "setThreadPin",
      );
      expect(pinCall).toBeTruthy();

      await remoteRowOne.click({ button: "right" });
      await remote.getByRole("menuitem", { name: "Unpin Thread" }).click();
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
      await remoteKimiParent.click({ button: "right" });
      await remote
        .getByRole("menuitem", { name: "Sub-thread in Same Worktree" })
        .click();

      const childPrompt = remote.getByRole("textbox", { name: "New thread" });
      await expect(childPrompt).toBeVisible();
      const childSettings = remote.getByLabel("New thread settings");
      const childProvider = childSettings.getByRole("button", {
        name: "Provider",
        exact: true,
      });
      await expect(childProvider).toContainText("Kimi");
      await childProvider.click();
      await remote.getByRole("option", { name: "OpenAI", exact: true }).click();
      await expect(childProvider).toContainText("OpenAI");

      const childTools = remote.getByLabel("Composer tools");
      const childEnvironment = childTools.getByRole("button", {
        name: "Environment",
        exact: true,
      });
      await expect(childEnvironment).toBeVisible();
      await childEnvironment.click();
      await remote.getByRole("option", { name: "PwrAgent", exact: true }).click();
      await expect(childEnvironment).toContainText("PwrAgent");

      await childPrompt.fill("/review");
      await remote.getByRole("button", { name: "Start thread" }).click();
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
          directoryPath: fixtureRepo,
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
      environmentSetupScript: `touch ${FEDERATION_CHILD_ENVIRONMENT_MARKER}`,
      commitMessage: "Seed federation environment fixture",
      initializeGit: false,
    });

    const protocolDir = path.join(fixtureRoot, "protocol");
    const requestLogPath = path.join(protocolDir, "fake-codex.protocol.jsonl");
    const launchMarkerPath = path.join(protocolDir, "fake-codex.launched");
    await mkdir(protocolDir, { recursive: true });

    let owner: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
    let viewer: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
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

      viewer = await launchElectronApp({
        requiresReplayDriver: false,
        secretStorage: "memory",
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
      await remote.waitForLoadState("domcontentloaded");

      const remoteKimiParent = remote.getByRole("button", {
        name: "Remote Kimi parent",
      });
      await expect(remoteKimiParent).toBeVisible({ timeout: 30_000 });
      await remoteKimiParent.click({ button: "right" });
      await remote
        .getByRole("menuitem", { name: "Sub-thread in Same Worktree" })
        .click();

      const childSettings = remote.getByLabel("New thread settings");
      const childProvider = childSettings.getByRole("button", {
        name: "Provider",
        exact: true,
      });
      await expect(childProvider).toContainText("Kimi");
      await childProvider.click();
      await remote.getByRole("option", { name: "OpenAI", exact: true }).click();
      await expect(childProvider).toContainText("OpenAI");

      const childAccessMode = childSettings.getByLabel("Access mode");
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
        .getByRole("button", { name: "Environment", exact: true });
      await expect(childEnvironment).toBeVisible();
      await childEnvironment.click();
      await remote.getByRole("option", { name: "PwrAgent", exact: true }).click();
      await expect(childEnvironment).toContainText("PwrAgent");

      await remote.getByRole("textbox", { name: "New thread" }).fill("/review");
      await remote.getByRole("button", { name: "Start thread" }).click();
      const reviewTarget = remote.getByRole("group", { name: "Review target" });
      await expect(reviewTarget).toBeVisible();
      await reviewTarget.getByRole("combobox", { name: "Base branch" }).click();
      await reviewTarget.getByRole("option", { name: "main", exact: true }).click();
      await reviewTarget.getByRole("button", { name: "Start review" }).click();

      // Owner retains environmentId=environment on the materialized child.
      await expect
        .poll(
          async () => await owner!.window.evaluate(
            async ({ parentThreadId }) => {
              const api = (window as typeof window & {
                pwragent?: {
                  getNavigationSnapshot?: (request: unknown) => Promise<{
                    threads: Array<{
                      codexEnvironmentRuntime?: { environmentId?: string };
                      parentThreadId?: string;
                      source: string;
                    }>;
                  }>;
                };
              }).pwragent;
              const snapshot = await api?.getNavigationSnapshot?.({ backend: "all" });
              return snapshot?.threads.find(
                (thread) =>
                  thread.source === "codex"
                  && thread.parentThreadId === parentThreadId,
              )?.codexEnvironmentRuntime?.environmentId;
            },
            { parentThreadId: parent.threadId },
          ),
          { timeout: 60_000 },
        )
        .toBe("environment");

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
    } finally {
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
