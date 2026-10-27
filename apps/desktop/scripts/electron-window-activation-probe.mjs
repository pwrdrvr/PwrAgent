// Run only on an isolated macOS desktop (PwrSuiteLab), never the operator's.
// Compares native application activation with and without replacing the menu
// on window focus. No PwrAgent profile, backend, or renderer is opened.
import { app, BrowserWindow, Menu } from "electron";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.log("SKIP: native window activation requires macOS");
  app.exit(0);
} else {
  const root = mkdtempSync(join(tmpdir(), "pwragent-activation-probe-"));
  app.setPath("userData", root);
  const helper = join(root, "activate");
  const source = join(root, "activate.swift");
  writeFileSync(source, `import AppKit
import CoreGraphics
let mode = CommandLine.arguments[1]
if mode == "activate" {
  let pid = Int32(CommandLine.arguments[2])!
  guard let target = NSRunningApplication(processIdentifier: pid) else { exit(2) }
  if !target.activate(options: [.activateIgnoringOtherApps]) { exit(3) }
} else if mode == "finder" {
  guard let target = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { exit(4) }
  print(target.processIdentifier)
} else {
  let pid = Int32(CommandLine.arguments[2])!
  let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  print(rows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { $0[kCGWindowNumber as String] as? Int })
}
`);
  const compile = spawnSync("xcrun", ["swiftc", source, "-o", helper], { encoding: "utf8" });
  if (compile.status !== 0) {
    console.error(compile.stderr);
    app.exit(1);
  }
  const native = (...args) => {
    const result = spawnSync(helper, args.map(String), { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`native ${args[0]}: ${result.status} ${result.stderr}`);
    return result.stdout.trim();
  };
  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let refreshOnFocus = false;
  let windows = [];
  const events = [];
  const snapshot = (event) => events.push({
    event,
    active: app.isActive(),
    key: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
    frontToBack: native("order", process.pid),
  });
  const refresh = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Probe", submenu: [{ role: "quit" }] },
    { role: "windowMenu" },
  ]));
  app.on("browser-window-focus", (_event, window) => {
    snapshot(`focus:${window.getTitle()}`);
    if (refreshOnFocus) refresh();
  });
  app.on("did-become-active", () => snapshot("did-become-active"));
  app.on("did-resign-active", () => snapshot("did-resign-active"));
  app.on("activate", () => snapshot("activate"));
  app.on("window-all-closed", () => {});
  void app.whenReady().then(async () => {
    try {
      const finderPid = Number(native("finder"));
      for (const rebuild of [true, false]) {
        refreshOnFocus = rebuild;
        refresh();
        windows = ["Local fixture", "Remote fixture"].map((title, i) => new BrowserWindow({
          title,
          x: 100 + i * 50,
          y: 100 + i * 50,
          width: 500,
          height: 400,
          titleBarStyle: "hiddenInset",
        }));
        for (const target of [windows[0], windows[1], windows[0]]) {
          events.length = 0;
          target.focus();
          await waitFor(() => target.isFocused(), "initial key window");
          await new Promise((resolve) => setTimeout(resolve, 100));
          snapshot("before-switch");
          native("activate", finderPid);
          await waitFor(() => !app.isActive(), "leave app");
          native("activate", process.pid);
          await waitFor(() => app.isActive(), "return to app");
          await new Promise((resolve) => setTimeout(resolve, 100));
          snapshot("after-switch");
          console.log(JSON.stringify({ rebuild, expected: target.getTitle(), actual: BrowserWindow.getFocusedWindow()?.getTitle(), events }));
        }
        for (const window of windows) window.destroy();
      }
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
