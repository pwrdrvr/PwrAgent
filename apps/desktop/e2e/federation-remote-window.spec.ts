import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
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
            methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
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
        ],
      });

      // Federation key material needs a writable secret store.
      app = await launchElectronApp({
        fixturePath: fixture.fixturePath,
        secretStorage: "memory",
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
      const remoteRowOne = remote.locator(".thread-row__title", {
        hasText: "Remote gateway thread one",
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
          async () => await remote.evaluate(async (directoryKey) => {
            const api = (window as typeof window & {
              pwragent?: {
                ensureDirectoryLaunchpad?: (request: unknown) => Promise<{
                  launchpad: { prompt: string };
                }>;
              };
            }).pwragent;
            if (!api?.ensureDirectoryLaunchpad) return "missing-api";
            const response = await api.ensureDirectoryLaunchpad({
              directoryKey,
              directoryKind: "directory",
              directoryLabel: "FixtureRepo",
              directoryPath: "/remote/FixtureRepo",
            });
            return response.launchpad.prompt;
          }, "directory:/remote/FixtureRepo"),
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
      await remoteRowOne.click();
      await expect(
        remote.getByRole("textbox", { name: "Reply" }),
      ).toBeVisible();

      // The gateway only ever served federation RPCs — no local PR
      // refresh or other local-only method leaked across the wire.
      expect(
        gateway.calls.map((call) => call.method),
      ).not.toContain("refreshThreadPullRequests");

      // Peer death: the window flips to an explicit read-only state —
      // disconnected banner, composer disabled — instead of a half-dead
      // surface hammering the peer with failing RPCs.
      await gateway.stop();
      await expect(
        remote.locator(".federation-disconnected-banner"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        remote.locator(".composer-tiptap-input__editor"),
      ).toHaveAttribute("contenteditable", "false", { timeout: 15_000 });

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
    } finally {
      await app?.close();
      await gateway?.close();
      await fixture.cleanup();
      await rm(ownerPtyCwd, { force: true, recursive: true });
    }
  });
});
