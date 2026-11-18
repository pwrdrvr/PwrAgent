import fs from "node:fs";

function replaceOnce(file, before, after) {
  const source = fs.readFileSync(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one instrumentation point in ${file}`);
  fs.writeFileSync(file, source.replace(before, after));
}

replaceOnce("apps/desktop/playwright.config.ts", '["list"],', '["list"], ["json", { outputFile: "star-map-results.json" }],');
replaceOnce("apps/desktop/src/renderer/src/App.tsx", "void desktopApi.openStarMapWindow().catch((error) => {", 'console.info("STAR_MAP_PROBE renderer:invoke");\n          void desktopApi.openStarMapWindow().catch((error) => {');
replaceOnce("apps/desktop/src/preload/index.ts", "await ipcRenderer.invoke(STAR_MAP_OPEN_WINDOW_CHANNEL, request);", 'console.info("STAR_MAP_PROBE preload:invoke");\n    await ipcRenderer.invoke(STAR_MAP_OPEN_WINDOW_CHANNEL, request);');
replaceOnce("apps/desktop/src/main/shell/ipc/star-map.ts", "async (event, request?: OpenStarMapWindowRequest): Promise<void> => {\n      showStarMapWindow({", `async (event, request?: OpenStarMapWindowRequest): Promise<void> => {
      (globalThis as typeof globalThis & { __starMapProbeEmit?: (stage: string, detail: unknown) => void })
        .__starMapProbeEmit?.("ipc:received", { sender: event.sender.id });
      showStarMapWindow({`);
replaceOnce("apps/desktop/e2e/fixtures/star-map-window.ts", 'import { expect, type ConsoleMessage, type Page } from "@playwright/test";', 'import { expect, type ConsoleMessage, type Page } from "@playwright/test";\nimport { startOpeningProbe } from "./star-map-opening-probe";');
replaceOnce("apps/desktop/e2e/fixtures/star-map-window.ts", "  const errorLog = recordRendererErrors(app.window);", "  const openingProbe = await startOpeningProbe(app);\n  const errorLog = recordRendererErrors(app.window);");
replaceOnce("apps/desktop/e2e/fixtures/star-map-window.ts", "    errorLog.stop();", "    errorLog.stop();\n    await openingProbe.finish();");

fs.writeFileSync("apps/desktop/e2e/fixtures/star-map-opening-probe.ts", `
import { appendFileSync } from "node:fs";
import { test, type ConsoleMessage } from "@playwright/test";
import type { launchElectronApp } from "./electron-app";
import { withProbeTimeout } from "./probe-report";

type App = Awaited<ReturnType<typeof launchElectronApp>>;
export async function startOpeningProbe(app: App) {
  const consoleEvents: { at: number; text: string }[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.text().startsWith("STAR_MAP_PROBE")) {
      consoleEvents.push({ at: Date.now(), text: message.text() });
    }
  };
  app.window.on("console", onConsole);
  await app.electronApp.evaluate(({ app: nativeApp, BrowserWindow }) => {
    const events: unknown[] = [];
    const emit = (stage: string, detail: unknown) => {
      if (events.length < 200) events.push({ at: Date.now(), stage, detail });
    };
    Object.assign(globalThis, { __starMapProbeEmit: emit, __starMapProbeEvents: events });
    const observe = (window: InstanceType<typeof BrowserWindow>) => {
      const snapshot = () => ({ id: window.id, url: window.webContents.getURL(),
        visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized() });
      emit("window:observed", snapshot());
      for (const event of ["focus", "blur", "show", "hide", "ready-to-show"] as const) {
        window.on(event, () => emit("window:" + event, snapshot()));
      }
      window.on("closed", () => emit("window:closed", { id: window.id }));
      window.webContents.on("did-finish-load", () => emit("window:loaded", snapshot()));
    };
    for (const window of BrowserWindow.getAllWindows()) observe(window);
    nativeApp.on("browser-window-created", (_event, window) => {
      emit("window:created", { id: window.id });
      observe(window);
    });
  });
  await app.window.evaluate(() => {
    const events: unknown[] = [];
    const trigger = document.querySelector('[aria-label="Open Star Map"]');
    const describe = (node: EventTarget | null) => node instanceof Element
      ? { tag: node.tagName, label: node.getAttribute("aria-label"), className: node.getAttribute("class") }
      : null;
    const snapshot = () => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState,
      triggerConnected: trigger?.isConnected, currentIsOriginal: trigger === document.querySelector('[aria-label="Open Star Map"]'),
      triggerRect: trigger?.getBoundingClientRect().toJSON(), active: describe(document.activeElement) });
    const record = (stage: string, detail: unknown) => {
      if (events.length < 200) events.push({ at: Date.now(), stage, detail, state: snapshot() });
    };
    record("armed", {});
    const controller = new AbortController();
    for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "focusin", "focusout"]) {
      for (const capture of [true, false]) {
        document.addEventListener(eventName, (event) => {
          const pointer = event as MouseEvent;
          record(eventName + (capture ? ":capture" : ":bubble"), {
            target: describe(event.target), trusted: event.isTrusted, prevented: event.defaultPrevented,
            path: event.composedPath().slice(0, 5).map(describe), x: pointer.clientX, y: pointer.clientY,
            underPointer: Number.isFinite(pointer.clientX) ? describe(document.elementFromPoint(pointer.clientX, pointer.clientY)) : null,
          });
        }, { capture, signal: controller.signal });
      }
    }
    const observer = new MutationObserver(() => {
      if (!trigger?.isConnected) record("trigger:detached", {});
    });
    observer.observe(document.body, { childList: true, subtree: true });
    Object.assign(window, { __starMapProbeEvents: events,
      __starMapProbeStop: () => { record("finished", {}); controller.abort(); observer.disconnect(); } });
  });
  return {
    async finish() {
      const readings = await Promise.allSettled([
        withProbeTimeout(() => app.window.evaluate(() => {
          const probe = window as Window & { __starMapProbeEvents?: unknown[]; __starMapProbeStop?: () => void };
          probe.__starMapProbeStop?.();
          return probe.__starMapProbeEvents;
        }), "opening probe renderer"),
        withProbeTimeout(() => app.electronApp.evaluate(() =>
          (globalThis as typeof globalThis & { __starMapProbeEvents?: unknown[] }).__starMapProbeEvents
        ), "opening probe main"),
      ]);
      app.window.off("console", onConsole);
      const row = { title: test.info().title, repeat: test.info().repeatEachIndex,
        consoleEvents, renderer: readings[0], main: readings[1] };
      appendFileSync("star-map-opening.jsonl", JSON.stringify(row) + "\\n");
      await test.info().attach("star-map-opening", { body: JSON.stringify(row, null, 2), contentType: "application/json" });
      console.log("STAR_MAP_OPENING " + JSON.stringify(row));
    },
  };
}
`);
