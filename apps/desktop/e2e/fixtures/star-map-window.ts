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
import { expect, type ConsoleMessage, type Page } from "@playwright/test";
import type { launchElectronApp } from "./electron-app";

type LaunchedApp = Awaited<ReturnType<typeof launchElectronApp>>;

/** How long the wait polls for the map window, and how often. */
const WAIT_ATTEMPTS = 30;
const WAIT_INTERVAL_MS = 200;

/**
 * Renderer-side noise captured across a click, so a wait that times out
 * can print what the page said instead of leaving it in a trace artifact
 * nobody downloads.
 */
type RendererErrorLog = {
  entries: () => string[];
  stop: () => void;
};

function recordRendererErrors(page: Page): RendererErrorLog {
  const entries: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    entries.push(`console.${type}: ${message.text()}`);
  };
  const onPageError = (error: Error): void => {
    entries.push(`pageerror: ${error.message}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    entries: () => [...entries],
    stop: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}

/**
 * Cap on one diagnostic probe.
 *
 * Neither `page.evaluate` nor `electronApp.evaluate` takes a timeout, so each
 * is bounded only by Playwright's 30s test timeout — and these run precisely
 * when something has already gone wrong, including the case where the process
 * being probed is the wedged one. Uncapped, a hung probe swallows this
 * helper's 6s report and the run fails with a bare "Test timeout of 30000ms
 * exceeded" instead, which says strictly less than the message this file
 * replaced.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Both probes answer with a string and never reject, so a probe that loses
 * this race simply stays unsettled — there is no rejection left to go
 * unhandled.
 */
async function withProbeTimeout(
  describe: () => Promise<string>,
  label: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      describe(),
      new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve(`${label} did not answer within ${PROBE_TIMEOUT_MS}ms`),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  errorLog?: RendererErrorLog,
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
  const rendererErrors = errorLog?.entries() ?? [];
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
      `  renderer errors during the wait: ${
        rendererErrors.length > 0 ? rendererErrors.join(" | ") : "(none)"
      }`,
    ].join("\n"),
  );
}

/**
 * Click the main window's header control and wait for the map window.
 *
 * The `expect.poll` is a readiness barrier, and it is the fix for the
 * flake this file was written for. `launchElectronApp` resolves on a
 * MAIN-PROCESS global (the replay driver installed from the
 * `BackendRegistry` constructor) — that says nothing about the renderer,
 * and the main process registers `STAR_MAP_OPEN_WINDOW_CHANNEL` before it
 * creates any window, so the only end that can still be unready when the
 * button is clickable is the preload bridge. Every other star-map spec
 * happened to wait for something the bridge has to serve — a thread row, a
 * completed Settings flow — before clicking, which is why the one spec
 * that clicks straight after launch was the only one that ever failed
 * here. This makes the barrier explicit instead of incidental.
 */
export async function openStarMapWindow(app: LaunchedApp): Promise<Page> {
  await expect
    .poll(
      async () =>
        await app.window.evaluate(
          () =>
            typeof (
              window as Window & {
                pwragent?: { openStarMapWindow?: unknown };
              }
            ).pwragent?.openStarMapWindow,
        ),
      {
        message:
          "the main window's preload bridge never exposed openStarMapWindow,"
          + " so the header control could never have opened the map",
      },
    )
    .toBe("function");

  const errorLog = recordRendererErrors(app.window);
  try {
    await app.window.getByRole("button", { name: "Open Star Map" }).click();
    return await waitForStarMapWindow(app, errorLog);
  } finally {
    errorLog.stop();
  }
}
