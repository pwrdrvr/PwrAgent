// Electron quit re-entry probe.
//
//   pnpm --filter @pwragent/desktop probe:quit-reentry
//
// Measures, on the Electron this checkout ships, what the unit model in
// src/main/__tests__/electron-quit-model.ts asserts and cannot itself prove:
// when a deferred quit is retried with app.quit(), does Electron still finish
// quitting? It exits non-zero if any case disagrees with the model, so re-run
// it on an Electron major bump.
//
// Why it can fail: Browser::Quit() writes `is_quitting_ = HandleBeforeQuit()`
// AFTER emitting before-quit, NotifyAndShutdown() writes
// `is_quitting_ = false` after a prevented will-quit, and an emit that starts
// from a native task runs a microtask checkpoint as it returns, inside those
// functions. A retry that settles in microtasks therefore runs nested and is
// overwritten: the window closes, Electron emits `window-all-closed` instead
// of `will-quit`, and the process lives on with no windows. See
// src/main/quit-retry.ts.
//
// The `pwragent` cases mirror src/main/index.ts as it was before
// quit-retry.ts: before-quit asks the quit manager, which with nothing
// blocking calls app.quit() synchronously from inside the listener; the next
// pass defers for resource shutdown, which closes the windows and then
// re-issues the quit from its promise chain; and window-all-closed re-issues
// it once shutdown has completed. "fault" makes the shutdown reject before it
// closes anything, which lets its retry settle inside the native before-quit
// dispatch. "rescued" means the quit finished only because window-all-closed
// asked again.
//
// Adapted from pwrdrvr/PwrSnap#677 (MIT, same owner). Every child is a hidden
// window under the accessory activation policy: nothing is drawn, no Dock
// icon, no focus taken. "Native" quits are SIGTERM, which Electron turns into
// a posted Browser::Quit task, the same shape as Dock → Quit. POSIX only;
// Windows runs the JS cases.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const STALL_MS = 3_000;
const caseArg = process.argv.find((arg) => arg.startsWith("--case="));

void app.whenReady().then(() => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  if (caseArg === undefined) runMatrix();
  else void runCase(JSON.parse(caseArg.slice("--case=".length)));
});

function runMatrix() {
  // [handler shape, how the retry is issued, how the quit starts, model says]
  const cases = [
    ["before-quit", "microtask", "native", "stall"],
    ["before-quit", "microtask", "js", "quit"],
    ["before-quit", "after-dispatch", "native", "quit"],
    ["before-quit", "after-dispatch", "js", "quit"],
    ["will-quit", "microtask", "native", "stall"],
    ["will-quit", "microtask", "js", "stall"],
    ["will-quit", "after-dispatch", "native", "quit"],
    ["will-quit", "after-dispatch", "js", "quit"],
    ["pwragent", "microtask", "native", "quit"],
    ["pwragent+fault", "microtask", "native", "rescued"],
    ["pwragent+fault-no-backstop", "microtask", "native", "stall"],
    ["pwragent+fault-no-backstop", "after-dispatch", "native", "quit"],
  ].filter(([, , start]) => start === "js" || process.platform !== "win32");

  const script = fileURLToPath(import.meta.url);
  let mismatches = 0;
  console.log(`Electron ${process.versions.electron} on ${process.platform}`);
  for (const [stage, retry, start, expected] of cases) {
    const userData = mkdtempSync(join(tmpdir(), "pwragent-quit-probe-"));
    const run = spawnSync(
      process.execPath,
      [script, `--case=${JSON.stringify({ stage, retry, start, userData })}`],
      { encoding: "utf8", timeout: STALL_MS * 4 },
    );
    rmSync(userData, { recursive: true, force: true });
    const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
    const result = line === undefined ? null : JSON.parse(line.slice("RESULT ".length));
    const observed =
      result === null
        ? "no result"
        : !result.quit
          ? "stall"
          : result.events.includes("backstop-quit")
            ? "rescued"
            : "quit";
    const ok = observed === expected;
    if (!ok) mismatches += 1;
    console.log(
      `${ok ? "ok  " : "DIFF"} ${stage.padEnd(26)} retry=${retry.padEnd(14)} start=${start.padEnd(6)} `
        + `model=${expected.padEnd(7)} electron=${observed}`
        + (result === null ? "" : `  [${result.events.join(", ")}]`),
    );
  }
  console.log(mismatches === 0 ? "model matches Electron" : `${mismatches} case(s) differ from the model`);
  app.exit(mismatches === 0 ? 0 : 1);
}

async function runCase({ stage, retry, start, userData }) {
  app.setPath("userData", userData);
  const events = [];
  const report = (quit) => {
    process.stdout.write(`RESULT ${JSON.stringify({ quit, events })}\n`);
  };
  // quit-retry.ts's retryQuitAfterDispatch, inlined: this file is plain JS.
  const reissue = () => {
    if (retry === "microtask") app.quit();
    else setImmediate(() => app.quit());
  };
  for (const name of ["before-quit", "will-quit", "window-all-closed"]) {
    app.on(name, () => events.push(name));
  }
  app.on("quit", () => {
    events.push("quit");
    report(true);
  });
  const win = new BrowserWindow({ show: false });
  win.on("closed", () => events.push("closed"));
  await win.loadURL("data:text/html,");

  if (stage.startsWith("pwragent")) {
    installPwrAgentShape({ events, fault: stage.includes("fault"), backstop: !stage.includes("no-backstop"), reissue });
  } else {
    let deferred = false;
    app.on(stage, (event) => {
      if (deferred) return;
      deferred = true;
      event.preventDefault();
      void Promise.resolve().then(reissue);
    });
  }

  setTimeout(() => {
    report(false);
    app.exit(2);
  }, STALL_MS);
  if (start === "native") process.kill(process.pid, "SIGTERM");
  else setTimeout(() => app.quit(), 0);
}

function installPwrAgentShape({ events, fault, backstop, reissue }) {
  let quitAllowed = false;
  let shutdownComplete = false;
  let shutdown;
  const dispose = async () => {
    if (fault) throw new Error("resource shutdown failed before closing windows");
    const windows = BrowserWindow.getAllWindows();
    await Promise.all(windows.map((window) => new Promise((resolve) => {
      window.once("closed", resolve);
      window.close();
    })));
  };
  const quitAfterResourceShutdown = () => {
    shutdown ??= dispose()
      .catch(() => {})
      .finally(() => {
        shutdownComplete = true;
        reissue();
      });
  };
  app.on("before-quit", (event) => {
    if (!quitAllowed) {
      event.preventDefault();
      // requestQuit() with no blockers: performQuit runs synchronously.
      quitAllowed = true;
      app.quit();
      return;
    }
    if (!shutdownComplete) {
      event.preventDefault();
      quitAfterResourceShutdown();
    }
  });
  app.on("window-all-closed", () => {
    if (backstop && quitAllowed && shutdownComplete) {
      events.push("backstop-quit");
      app.quit();
    }
  });
}
