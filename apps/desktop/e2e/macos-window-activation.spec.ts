import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { tolerateTransientRpcFailure } from "./fixtures/transient-rpc-poll";

const run = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));

test.describe("native macOS window activation", () => {
  test.skip(process.platform !== "darwin", "Requires the isolated macOS E2E desktop");
  test.describe.configure({ retries: 0 });

  test("application activation preserves either selected window and the native Window menu", async () => {
    test.setTimeout(90_000);
    const testInfo = test.info();
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-activation-e2e-"));
    const helper = path.join(root, "activate");
    await run("xcrun", ["swiftc", path.join(directory, "fixtures/macos-window-activation.swift"), "-o", helper], { timeout: 60_000 });
    const native = (...args: string[]) => run(helper, args, { timeout: 10_000 });
    const finderPid = Number((await native("finder")).stdout.trim());
    const fixture = await launchElectronApp({
      fixturePath: path.join(directory, "fixtures/smoke/replay.fixture.json"),
    });
    const traces: unknown[] = [];
    try {
      const ids = await fixture.electronApp.evaluate(async ({ app, BrowserWindow, Menu }) => {
        const local = BrowserWindow.getAllWindows().find((window) => window.getTitle() === "PwrAgent")!;
        const viewer = new BrowserWindow({
          title: "PwrAgent - Fixture remote / default",
          width: 600,
          height: 400,
          titleBarStyle: "hiddenInset",
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        await viewer.loadURL("data:text/html,<title>PwrAgent - Fixture remote / default</title><p>Remote viewer fixture</p>");
        viewer.show();
        const events: unknown[] = [];
        const snapshot = (event: string) => events.push({
          event,
          active: app.isActive(),
          key: BrowserWindow.getFocusedWindow()?.id ?? null,
        });
        app.on("browser-window-focus", (_event, window) => snapshot(`main:${window.id}`));
        app.on("did-become-active", () => snapshot("did-become-active"));
        app.on("did-resign-active", () => snapshot("did-resign-active"));
        app.on("activate", () => snapshot("activate"));
        Reflect.set(globalThis, "__activationProbe", { events, menu: Menu.getApplicationMenu() });
        return {
          local: local.id,
          viewer: viewer.id,
          nativeLocal: Number(local.getMediaSourceId().split(":")[1]),
          nativeViewer: Number(viewer.getMediaSourceId().split(":")[1]),
        };
      });
      const pid = fixture.electronApp.process().pid!;
      const active = tolerateTransientRpcFailure(() =>
        fixture.electronApp.evaluate(({ app }) => app.isActive()),
      );
      // On macOS, BrowserWindow.focus() activates the app with
      // activateIgnoringOtherApps:NO, which does nothing while another app is
      // active. Launch leaves the app inactive whenever macOS has already
      // given activation to another app, such as Finder after the previous
      // spec's app quit. A window can't be key in an inactive app, so focus()
      // would never select one. Activate the app as the operator would.
      traces.push({
        mode: "launch",
        ...await fixture.electronApp.evaluate(({ app, BrowserWindow }) => ({
          active: app.isActive(),
          key: BrowserWindow.getFocusedWindow()?.id ?? null,
        })),
        frontmost: JSON.parse((await native("frontmost")).stdout) as unknown,
      });
      await native("activate", String(pid));
      await expect.poll(active.read).toBe(true).catch(active.rethrowWithLastFailure);
      for (const mode of ["activate", "reopen"]) {
        for (const [target, nativeId] of [[ids.local, ids.nativeLocal], [ids.viewer, ids.nativeViewer]]) {
          await fixture.electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), target!);
          const selected = tolerateTransientRpcFailure(() =>
            fixture.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id),
          );
          await expect.poll(selected.read).toBe(target).catch(selected.rethrowWithLastFailure);
          await native("activate", String(finderPid));
          const inactive = tolerateTransientRpcFailure(() =>
            fixture.electronApp.evaluate(({ app }) => app.isActive()),
          );
          await expect.poll(inactive.read).toBe(false).catch(inactive.rethrowWithLastFailure);
          await native(mode, String(pid));
          await expect.poll(active.read).toBe(true).catch(active.rethrowWithLastFailure);
          const state = await fixture.electronApp.evaluate(async ({ BrowserWindow, Menu }) => {
            // Drain posted menu installation tasks before inspecting key state.
            await new Promise<void>((resolve) => setImmediate(resolve));
            const probe = Reflect.get(globalThis, "__activationProbe") as { events: unknown[]; menu: unknown };
            return {
              key: BrowserWindow.getFocusedWindow()?.id,
              sameMenu: Menu.getApplicationMenu() === probe.menu,
              events: probe.events.splice(0),
            };
          });
          const order = JSON.parse((await native("order", String(pid))).stdout) as number[];
          traces.push({ mode, target, nativeId, order, ...state });
          expect(state.key, JSON.stringify(traces.at(-1))).toBe(target);
          expect(order[0], "Visually frontmost window must also own the key window").toBe(nativeId);
          expect(state.sameMenu, "Focus must preserve the installed native Window menu").toBe(true);
        }
      }
    } finally {
      const tracePath = testInfo.outputPath("native-activation-events.json");
      await writeFile(tracePath, JSON.stringify(traces, null, 2));
      await testInfo.attach("native-activation-events", {
        path: tracePath, contentType: "application/json",
      });
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
