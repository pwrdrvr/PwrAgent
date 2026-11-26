// Opening the Star Map's dedicated OS window, and reporting what went
// wrong when it does not open.
//
// Three specs drive the map (`star-map-thread-flow`,
// `star-map-chat-card-history`, and the star-map block in `a11y`) and each
// carried its own copy of the wait. They shared a failure message too:
// "Star Map window did not open; current windows: <the main window>",
// which is what a Linux lane produced twice in a row on PR #1792 and is
// the same sentence whether the renderer never sent the IPC, the main
// process never made the window, or Playwright never attached to a window
// that exists. Those have different fixes and the CI log is usually all
// anybody has, so the wait now reports which one it was.
import { expect, type ConsoleMessage, type Locator, type Page } from "@playwright/test";
import type { DesktopApi } from "../../src/renderer/src/lib/desktop-api";
import type { launchElectronApp } from "./electron-app";
import { withProbeTimeout } from "./probe-report";
import { retryTransientRpcCall, tolerateTransientRpcFailure } from "./transient-rpc-poll";

type LaunchedApp = Awaited<ReturnType<typeof launchElectronApp>>;

/** How long the wait polls for the map window, and how often. */
const WAIT_ATTEMPTS = 30;
const WAIT_INTERVAL_MS = 200;

/**
 * Renderer-side noise captured across a click, so a wait that times out
 * can print what the page said instead of leaving it in a trace artifact
 * nobody downloads.
 */
type RendererOpenLog = {
  errors: string[];
  milestones: string[];
  stop: () => void;
};

const OPEN_MILESTONE_PREFIX = "[star-map-open] ";

function recordRendererOpen(page: Page): RendererOpenLog {
  const errors: string[] = [];
  const milestones: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    const type = message.type();
    const text = message.text();
    if (type === "debug" && text.startsWith(OPEN_MILESTONE_PREFIX)) {
      milestones.push(text.slice(OPEN_MILESTONE_PREFIX.length));
    } else if (type === "error" || type === "warning") {
      errors.push(`console.${type}: ${text}`);
    }
  };
  const onPageError = (error: Error): void => {
    errors.push(`pageerror: ${error.message}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    errors,
    milestones,
    stop: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}

/**
 * Is the preload bridge that the header control calls actually live?
 *
 * `App.tsx` opens the map through `desktopApi?.openStarMapWindow?.()`, and
 * `useDesktopApi` resolves that bridge by polling — so the control is
 * mounted and clickable whether or not it can do anything yet, and a click
 * that lands early is dropped without a sound. This is the single fact
 * that tells that case apart from a main-process failure.
 */
async function describeStarMapBridge(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const bridge = (
        window as Window & { pwragent?: Record<string, unknown> }
      ).pwragent;
      if (!bridge) return "window.pwragent is absent";
      return `window.pwragent.openStarMapWindow is ${typeof bridge.openStarMapWindow}`;
    });
  } catch (error) {
    return `bridge probe failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * The main process's own window census. Playwright's `windows()` lists
 * only the pages it has attached to, so a map window that exists but went
 * unattached looks exactly like one that was never created — until these
 * two lists disagree.
 */
async function describeMainProcessWindows(app: LaunchedApp): Promise<string> {
  try {
    const urls = await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(
        (win) => win.webContents.getURL() || "(no url)",
      ),
    );
    return urls.length > 0 ? urls.join(", ") : "(none)";
  } catch (error) {
    return `window census failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Poll `electronApp.windows()` for the dedicated Star Map window. The
 * BrowserWindow is created with `show: false`, so Playwright's `window`
 * event fires before the URL has loaded; polling sidesteps the race
 * (same pattern as `appearance-broadcast.spec.ts`).
 *
 * Deliberately not exported: this is the wait WITHOUT the readiness barrier,
 * and handing a spec that version is exactly how the flake below comes back.
 * Go through `openStarMapWindow`.
 */
async function waitForStarMapWindow(
  app: LaunchedApp,
  openLog: RendererOpenLog,
  route: "header" | "preload",
): Promise<Page> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    for (const candidate of app.electronApp.windows()) {
      if (candidate.url().includes("#star-map")) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }

  // Gathered only on the failing path: each probe is a round trip, and the
  // bridge one runs script in a renderer that may already be wedged.
  const [bridge, mainProcessWindows] = await Promise.all([
    withProbeTimeout(
      async () => await describeStarMapBridge(app.window),
      "the renderer",
    ),
    withProbeTimeout(
      async () => await describeMainProcessWindows(app),
      "the main process",
    ),
  ]);
  throw new Error(
    [
      `Star Map window did not open after ${
        (WAIT_ATTEMPTS * WAIT_INTERVAL_MS) / 1000
      }s.`,
      `  windows Playwright sees: ${app.electronApp
        .windows()
        .map((win) => win.url())
        .join(", ")}`,
      `  windows the main process has: ${mainProcessWindows}`,
      `  preload bridge in the main window: ${bridge}`,
      `  ${route} open milestones: ${openLog.milestones.join(" → ") || "(none)"}`,
      `  renderer errors during the wait: ${
        openLog.errors.join(" | ") || "(none)"
      }`,
    ].join("\n"),
  );
}

/**
 * Make the map window the foreground window, and wait until its renderer
 * agrees.
 *
 * The Star Map deliberately goes inactive when it is not focused:
 * `useStarMapForeground` is
 * `visibilityState === "visible" && document.hasFocus()`, and the screen
 * passes it to every feed as `active`. For `useStarMapProjectPages` that
 * becomes `controller.setVisible(false)`, and
 * `NavigationWindowController.read` returns early unless the resource is
 * current — which requires visibility. A `Load more` press that lands while
 * the window is inactive is therefore discarded with no error, no spinner
 * and no state change, and `setVisible(true)` re-reads each resource from
 * the start rather than replaying the continuation it dropped. That is the
 * intended product behavior, so a spec that drives a pagination control has
 * to hold the foreground rather than expect the map to answer without it.
 *
 * `openStarMapWindow` deliberately does NOT do this — it only waits for the
 * MAIN window to be visible, and explicitly tolerates the runner never
 * making the app frontmost. Only the specs that depend on the map being
 * active need this, and they should say so.
 */
export async function focusStarMapWindow(
  app: LaunchedApp,
  mapWindow: Page,
): Promise<void> {
  // Mapping a Page to its BrowserWindow is a pure read. CDP can collect its
  // result under memory pressure even while the map remains healthy.
  const nativeMapWindow = await retryTransientRpcCall(() =>
    app.electronApp.browserWindow(mapWindow)
  );
  await nativeMapWindow.evaluate((win) => {
    win.show();
    win.focus();
  });
  const foreground = tolerateTransientRpcFailure(async () =>
    await mapWindow.evaluate(
      () => `${document.visibilityState}/${document.hasFocus()}`,
    )
  );
  await expect
    .poll(foreground.read, {
      message:
        "the Star Map window never became active (visible + focused), so"
        + " every feed on it stays suspended and a pagination press would be"
        + " discarded in silence",
    })
    .toBe("visible/true")
    .catch(foreground.rethrowWithLastFailure);
}

/**
 * Click the main window's header control and wait for the map window.
 *
 * The replay driver is a main-process readiness signal. Wait for the
 * preload bridge and native visibility before opening. A spec that starts
 * from a selected thread can scope the click to its settled header so the
 * loading header cannot be replaced in the middle of the gesture.
 *
 * Specs that exercise behavior inside the native window can opt into the
 * preload call as setup. The default exercises the header control.
 */
export async function openStarMapWindow(
  app: LaunchedApp,
  options?: { viaPreload: true } | { viaPreload?: false; header?: Locator },
): Promise<Page> {
  // Both barriers read across the Electron RPC boundary, so both are wrapped:
  // `expect.poll` does not retry a THROWING callback, and a round trip can
  // fail for reasons unrelated to the readiness being polled. See
  // `tolerateTransientRpcFailure`.
  const bridgeMethod = tolerateTransientRpcFailure(async () =>
    await app.window.evaluate(
      () =>
        typeof (
          window as Window & {
            pwragent?: { openStarMapWindow?: unknown };
          }
        ).pwragent?.openStarMapWindow,
    )
  );
  await expect
    .poll(bridgeMethod.read, {
      message:
        "the main window's preload bridge never exposed openStarMapWindow,"
        + " so the header control could never have opened the map",
    })
    .toBe("function")
    .catch(bridgeMethod.rethrowWithLastFailure);

  // A DOM-clickable header can precede native ready-to-show. Wait for the
  // window to be shown, but do not require OS focus: the runner can deliver
  // Playwright input without macOS making this the foreground application.
  const nativeWindow = await app.electronApp.browserWindow(app.window);
  const nativeWindowShown = tolerateTransientRpcFailure(async () =>
    await nativeWindow.evaluate((window) => window.isVisible())
  );
  await expect
    .poll(nativeWindowShown.read)
    .toBe(true)
    .catch(nativeWindowShown.rethrowWithLastFailure);

  const openLog = recordRendererOpen(app.window);
  try {
    if (options?.viaPreload) {
      await app.window.evaluate(async () => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        console.debug("[star-map-open] invoking main");
        await api.openStarMapWindow!();
        console.debug("[star-map-open] main acknowledged open");
      });
    } else {
      const header = options?.header ?? app.window;
      await header.getByRole("button", { name: "Open Star Map", exact: true }).click();
    }
    return await waitForStarMapWindow(app, openLog, options?.viaPreload ? "preload" : "header");
  } finally {
    openLog.stop();
  }
}
