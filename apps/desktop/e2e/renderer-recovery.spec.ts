import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { tolerateTransientRpcFailure } from "./fixtures/transient-rpc-poll";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(specDir, "fixtures/turn-lifecycle/replay.fixture.json");

// Test-only fault injection into the real production boundary. No app API or
// shipped environment flag can induce a crash. The fixture contains no user data.
async function injectBoundaryFault(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ElementShape = { props: { children: ElementShape }; type: unknown };
    type Boundary = {
      props: { children: ElementShape };
      retryManually?: () => void;
      forceUpdate: () => void;
    };
    type Fiber = { child?: Fiber; sibling?: Fiber; stateNode?: Boundary | { current?: Fiber } };
    const root = document.getElementById("root")!;
    const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"))!;
    const container = (root as unknown as Record<string, Fiber>)[key];
    // The DOM container can retain the alternate HostRoot. Its owner points
    // to the currently committed tree, including immediately after mounting.
    const current = container.stateNode && "current" in container.stateNode
      ? container.stateNode.current
      : undefined;
    const pending: Fiber[] = [current ?? container];
    let boundary: Boundary | undefined;
    while (pending.length) {
      const fiber = pending.pop()!;
      if (fiber.stateNode && "retryManually" in fiber.stateNode && fiber.stateNode.retryManually) {
        boundary = fiber.stateNode;
        break;
      }
      if (fiber.child) pending.push(fiber.child);
      if (fiber.sibling) pending.push(fiber.sibling);
    }
    if (!boundary) throw new Error("Root recovery boundary not found");
    const suspense = boundary.props.children;
    const content = suspense.props.children;
    const fault = { failing: true };
    (window as unknown as { recoveryTestFault: typeof fault }).recoveryTestFault = fault;
    function RecoveryTestFault() {
      if (fault.failing) throw new Error("Contrived renderer recovery fault");
      return content;
    }
    // Keep the props object shared with the fiber: forceUpdate restores the
    // instance's props from that fiber before rendering. This production build
    // does not freeze props. Replacing only instance.props discards the fault.
    boundary.props.children = {
      ...suspense,
      props: { ...suspense.props, children: { ...content, type: RecoveryTestFault } },
    };
    boundary.forceUpdate();
  });
}

test("remounts the UI with its unsent draft while the main-owned turn completes", async () => {
  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
    await app.window.getByLabel("Reply").fill("Start the contrived recovery turn.");
    await app.window.getByRole("button", { name: "Send", exact: true }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.window.getByLabel("Reply").fill("Keep this unsent draft through recovery.");
    const mainPid = await app.electronApp.evaluate(() => process.pid);
    const timeOrigin = await app.window.evaluate(() => performance.timeOrigin);
    await injectBoundaryFault(app.window);
    await expect(app.window.getByRole("alert")).toContainText("Restoring this window");
    await app.window.evaluate(() => {
      (window as unknown as { recoveryTestFault: { failing: boolean } }).recoveryTestFault.failing = false;
    });
    // The UI is still in its fallback while main consumes and persists the
    // provider's completion. Recovery must hydrate that work, without re-send.
    await app.electronApp.evaluate(async () => {
      for (const stepId of [
        "token-usage-1",
        "rate-limits-1",
        "command-output-1",
        "status-idle-midturn",
        "assistant-delta-1",
        "assistant-delta-2",
        "status-idle-1",
        "turn-completed-1",
      ]) {
        await globalThis.__PWRAGENT_REPLAY_DRIVER__!.advance({ stepId });
      }
    });
    await expect(app.window.getByRole("alert")).toHaveCount(0);
    await expect(app.window.getByRole("heading", { level: 2, name: "Turn lifecycle replay" })).toBeVisible();
    await expect(app.window.getByLabel("Reply")).toContainText("Keep this unsent draft through recovery.");
    await expect(app.window.getByText("Created /tmp/pwragent-turn-lifecycle.txt with exactly the text lifecycle second turn.")).toBeVisible();
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    expect(await app.electronApp.evaluate(() => process.pid)).toBe(mainPid);
    expect(await app.window.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  } finally {
    await app.close();
  }
});

test("stops repeated boundary failures and allows a manual remount", async ({ browserName: _browserName }, testInfo) => {
  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
    await injectBoundaryFault(app.window);
    await expect(app.window.getByRole("alert")).toContainText("Automatic recovery stopped");
    await app.window.screenshot({ path: testInfo.outputPath("renderer-recovery-fallback.png") });
    await app.window.evaluate(() => {
      (window as unknown as { recoveryTestFault: { failing: boolean } }).recoveryTestFault.failing = false;
    });
    await app.window.getByRole("button", { name: "Try again" }).click();
    await expect(app.window.getByRole("alert")).toHaveCount(0);
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("reloads after actual renderer termination while retaining the main process and saved drafts", async () => {
  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
    await app.window.getByLabel("Reply").fill("Saved before renderer termination.");
    // The existing draft policy flushes when the window loses focus. Wait for
    // the IPC response so this tests saved recovery rather than racing a save.
    await app.window.evaluate(async () => {
      window.dispatchEvent(new Event("blur"));
      const api = (window as unknown as { pwragent: { listComposerDraftLatest: () => Promise<unknown> } }).pwragent;
      await api.listComposerDraftLatest();
    });
    const identity = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { pid: process.pid, windowId: window.id, webContentsId: window.webContents.id };
    });
    const timeOrigin = await app.window.evaluate(() => performance.timeOrigin);
    await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      // Establish termination before checking readiness. forcefullyCrashRenderer
      // returns before the crash event, so polling immediately can see the old,
      // still healthy document and incorrectly pass the barrier.
      const gone = new Promise<void>((resolve) => {
        contents.once("render-process-gone", () => resolve());
      });
      contents.forcefullyCrashRenderer();
      await gone;
    });
    // Inspect via main while the old page is crashed. The replacement must
    // finish loading before the visible shell assertion gates React readiness.
    const restored = tolerateTransientRpcFailure(() => app.electronApp.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return !contents.isCrashed() && !contents.isLoading();
    }));
    await expect.poll(restored.read).toBe(true).catch(restored.rethrowWithLastFailure);
    await expect(app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first()).toBeVisible();
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByLabel("Reply")).toContainText("Saved before renderer termination.");
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { pid: process.pid, windowId: window.id, webContentsId: window.webContents.id };
    })).toEqual(identity);
    expect(await app.window.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
  } finally {
    await app.close();
  }
});
