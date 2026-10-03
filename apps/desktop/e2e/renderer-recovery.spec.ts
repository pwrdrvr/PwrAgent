import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(specDir, "fixtures/turn-lifecycle/replay.fixture.json");

// Test-only fault injection into the real production boundary. No app API or
// shipped environment flag can induce a crash. The fixture contains no user data.
async function injectBoundaryFault(page: Page, persistent = false): Promise<void> {
  await page.evaluate((keepFailing) => {
    type ElementShape = { props: { children: ElementShape }; type: unknown };
    type Boundary = {
      props: { children: ElementShape };
      retryManually?: () => void;
      forceUpdate: () => void;
    };
    type Fiber = { child?: Fiber; sibling?: Fiber; stateNode?: Boundary };
    const root = document.getElementById("root")!;
    const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"))!;
    const pending: Fiber[] = [(root as unknown as Record<string, Fiber>)[key]];
    let boundary: Boundary | undefined;
    while (pending.length) {
      const fiber = pending.pop()!;
      if (fiber.stateNode?.retryManually) {
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
    boundary.props = {
      ...boundary.props,
      children: { ...suspense, props: { ...suspense.props, children: { ...content, type: RecoveryTestFault } } },
    };
    boundary.forceUpdate();
    if (!keepFailing) setTimeout(() => { fault.failing = false; }, 100);
  }, persistent);
}

test("remounts the UI with its unsent draft while the main-owned turn completes", async () => {
  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
    await app.window.getByLabel("Reply").fill("Start the contrived recovery turn.");
    await app.window.getByRole("button", { name: "Send", exact: true }).click();
    await app.advance({ stepId: "turn-started-1" });
    await expect(app.window.getByTestId("composer-stop-turn")).toBeVisible();
    await app.window.getByLabel("Reply").fill("Keep this unsent draft through recovery.");
    const mainPid = await app.electronApp.evaluate(() => process.pid);
    const timeOrigin = await app.window.evaluate(() => performance.timeOrigin);
    await injectBoundaryFault(app.window);
    await expect(app.window.getByRole("alert")).toContainText("Restoring this window");
    // The UI is still in its fallback while main consumes and persists the
    // provider's completion. Recovery must hydrate that work, without re-send.
    await app.advance({ stepId: "turn-completed-1" });
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
    await injectBoundaryFault(app.window, true);
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
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
    // Inspect via main while the old page is crashed. did-finish-load means
    // the replacement document exists; the visible shell assertion gates React.
    await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return !contents.isCrashed() && !contents.isLoading();
    })).toBe(true);
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
