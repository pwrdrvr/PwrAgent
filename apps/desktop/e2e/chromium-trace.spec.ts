import { createServer } from "node:http";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createPackage } from "@electron/asar";
import type { HotCpuProfileCapturedEvent } from "../src/shared/hot-cpu-profile";
import type { ChromiumTrace } from "../src/main/diagnostics/chromium-trace";
import type { chromiumTraceProcessor } from "../src/main/diagnostics/chromium-trace-processor";
import type { createChromiumTraceSession } from "../src/main/shell/diagnostics/chromium-trace-session";
import type { startChromiumTraceFilterProcess } from "../src/main/shell/diagnostics/chromium-trace-filter-process";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test } from "./fixtures/electron-test";

const here = path.dirname(fileURLToPath(import.meta.url));

test("native rolling trace evicts old events and publishes only filtered timing data", async () => {
  const info = test.info();
  test.setTimeout(90_000);
  let controller = "";
  let packagedUtility = "";
  const mainOutput = path.join(here, "../out/main");
  const utility = path.join(mainOutput, "chromium-trace-utility.js");
  const app = await launchElectronApp({
    fixturePath: path.join(here, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      controller = path.join(homeRoot, "production-chromium-trace.cjs");
      await build({
        stdin: {
          contents: `
            export { ChromiumTrace } from "./diagnostics/chromium-trace";
            export { chromiumTraceProcessor } from "./diagnostics/chromium-trace-processor";
            export { createChromiumTraceSession } from "./shell/diagnostics/chromium-trace-session";
            export { startChromiumTraceFilterProcess } from "./shell/diagnostics/chromium-trace-filter-process";
          `,
          resolveDir: path.join(here, "../src/main"),
        },
        outfile: controller, bundle: true, platform: "node", format: "cjs",
        external: ["electron"], logLevel: "silent",
      });
      // Exercise the actual minified utility, worker and local imports through
      // Electron's ASAR loader, as the packaged app does.
      const stage = path.join(homeRoot, "trace-filter-package");
      const archive = path.join(homeRoot, "trace-filter.asar");
      await cp(mainOutput, stage, {
        recursive: true,
        filter: (source) => !source.endsWith(".map"),
      });
      await writeFile(path.join(stage, "package.json"), '{"type":"module"}');
      await createPackage(stage, archive);
      packagedUtility = path.join(archive, path.basename(utility));
    },
  });
  const artifact = info.outputPath("renderer.trace.json");
  const externalFile = path.join(app.homeRoot, "external-oracle.json");
  const privateValue = "synthetic-private-trace-value";
  const server = createServer((_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end('<!doctype html><body><main style="display:flex;width:300px"><div style="flex:1">Trace fixture</div></main>');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/trace-resource?token=${privateValue}`;
    const result = await app.electronApp.evaluate(async ({ BrowserWindow, contentTracing }, args) => {
      const require = process.getBuiltinModule("node:module").createRequire(args.controller);
      const {
        ChromiumTrace: Trace, createChromiumTraceSession: createSession, chromiumTraceProcessor: createPublisher,
        startChromiumTraceFilterProcess: startFilter,
      } = require(args.controller) as {
        ChromiumTrace: typeof ChromiumTrace;
        createChromiumTraceSession: typeof createChromiumTraceSession;
        chromiumTraceProcessor: typeof chromiumTraceProcessor;
        startChromiumTraceFilterProcess: typeof startChromiumTraceFilterProcess;
      };
      const fs = require("node:fs/promises") as typeof import("node:fs/promises");
      process.getBuiltinModule("node:v8").setFlagsFromString("--expose_gc");
      const collectGarbage = process.getBuiltinModule("node:vm").runInNewContext("gc") as () => void;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const target = new BrowserWindow({ width: 640, height: 480, webPreferences: { backgroundThrottling: false } });
      const warnings: string[] = [];
      const publish = createPublisher(() => startFilter(args.utility));
      try {
        await target.loadURL(args.origin);
        const owner = {};
        await contentTracing.startRecording({
          included_categories: ["blink.user_timing"], excluded_categories: ["*"],
        });
        const rejected = new Trace(createSession, publish, (message) => warnings.push(message));
        let externalConflict: Awaited<ReturnType<ChromiumTrace["capture"]>>;
        try {
          await rejected.arm(owner);
          externalConflict = await rejected.capture(owner, args.artifact, performance.now());
          await rejected.release(owner);
          await target.webContents.executeJavaScript("performance.mark('external-owner-still-recording')");
        } finally {
          await contentTracing.stopRecording(args.externalFile);
        }
        const externalStillOwned = (await fs.readFile(args.externalFile, "utf8")).includes("external-owner-still-recording");
        const conflictWarnings = warnings.splice(0);

        async function run(untilFull: boolean) {
          await target.loadURL(args.origin);
          const raw: Buffer[] = [];
          const trace = new Trace(() => {
            const session = createSession();
            return {
              ...session,
              start: (config) => session.start(untilFull ? { ...config, recordMode: "recordUntilFull" } : config),
              async *read(signal, reportPhase) {
                for await (const chunk of session.read(signal, reportPhase)) {
                  raw.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
                  yield chunk;
                }
              },
            };
          }, untilFull ? publish : createPublisher(() => startFilter(args.packagedUtility)),
          (message) => warnings.push(message), { bufferSizeKb: 1024 });
          const owner = {};
          try {
            await trace.arm(owner);
            // The capture must still export after V8 collects unreachable
            // wrappers in the main process while the recorder is armed.
            await new Promise<void>((resolve) => setImmediate(resolve));
            collectGarbage();
            await new Promise<void>((resolve) => setImmediate(resolve));
            await target.webContents.executeJavaScript("performance.mark('early-overflow-marker')");
            for (let batch = 0; batch < 24; batch += 1) {
              await target.webContents.executeJavaScript(`
                for (let i = 0; i < 1200; i++) {
                  performance.mark('flood-${batch}-' + i + '-' + 'x'.repeat(180));
                }
                performance.clearMarks();
              `);
              // Let the producer drain between bursts so they reach the ring.
              await wait(25);
            }
            // Chromium regenerates Perfetto's evicted interned state every 500 ms.
            await wait(750);
            const trigger = performance.now();
            const widths = await target.webContents.executeJavaScript(`
              (async () => {
                performance.mark('recent-overflow-marker');
                performance.mark(${JSON.stringify(args.privateValue)});
                await fetch(${JSON.stringify(args.url)}).then((response) => response.text());
                await new Promise((done) => requestAnimationFrame(done));
                const main = document.querySelector('main');
                const child = main.firstElementChild;
                const before = child.offsetWidth;
                main.style.width = '513px';
                const after = child.offsetWidth;
                await new Promise((done) => requestAnimationFrame(done));
                performance.clearMarks();
                return [before, after];
              })()
            `);
            await wait(100);
            const capture = await trace.capture(owner, args.artifact, trigger);
            const mode = untilFull ? "recordUntilFull" : "recordContinuously";
            if (capture.status !== "written") {
              throw new Error(`${mode} capture did not publish: ${JSON.stringify(capture)} (${raw.length} chunks)`);
            }
            const exported = Buffer.concat(raw).toString("utf8");
            const events: { name?: string }[] = JSON.parse(exported).traceEvents;
            return {
              capture,
              early: events.some((event) => event.name === "early-overflow-marker"),
              recent: events.some((event) => event.name === "recent-overflow-marker"),
              hadPrivateUrl: exported.includes(args.url),
              widths,
            };
          } finally {
            await trace.release(owner);
          }
        }
        const old = await run(true);
        const rolling = await run(false);
        return {
          old, rolling, warnings, externalConflict, externalStillOwned, conflictWarnings,
          electron: process.versions.electron, chromium: process.versions.chrome,
        };
      } finally {
        target.destroy();
      }
    }, { controller, artifact, externalFile, utility, packagedUtility, origin, privateValue, url });

    expect(result.externalConflict).toEqual({ status: "skipped", reason: "not-recording" });
    expect(result.externalStillOwned).toBe(true);
    expect(result.conflictWarnings).toEqual(["Could not arm Chromium trace"]);
    expect(result.warnings).toEqual([]);
    expect(result.old).toMatchObject({ capture: { status: "written" }, early: true, recent: false });
    expect(result.rolling).toMatchObject({
      capture: { status: "written", filterCpuMs: expect.any(Number), filterElapsedMs: expect.any(Number) },
      early: false, recent: true, hadPrivateUrl: true,
    });
    expect(result.rolling.widths).toEqual([300, 513]);
    console.log(`Chromium trace oracle ran on Electron ${result.electron}, Chromium ${result.chromium}`);
    const saved = await readFile(artifact, "utf8");
    expect(saved).not.toContain(privateValue);
    expect(saved).not.toContain(url);
    expect(JSON.parse(saved).traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Layout", ts: expect.any(Number) }),
      expect.objectContaining({ name: "ResourceSendRequest" }),
    ]));
  } finally {
    try {
      await app.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("automatic hot CPU capture preserves renderer layout while the V8 profile keeps recording", async () => {
  test.setTimeout(90_000);
  const app = await launchElectronApp({
    fixturePath: path.join(here, "fixtures/smoke/replay.fixture.json"),
    env: {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "0",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "250",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "25",
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
      PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "2",
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "5000",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "1",
    },
  });
  const marker = "contrived-private-renderer-mark";
  try {
    const widths = await app.window.evaluate(async (privateMark) => {
      const page = window as unknown as {
        profile: Promise<HotCpuProfileCapturedEvent>;
        pwragent: {
          onHotCpuProfileCaptured: (callback: (event: HotCpuProfileCapturedEvent) => void) => () => void;
          writeSettingsConfig: (request: { patch: { general: {
            hotCpuProfilingEnabled: boolean;
            hotCpuProfilingCaptureChromiumTrace: boolean;
          } } }) => Promise<unknown>;
        };
      };
      page.profile = new Promise((resolve) => {
        const unsubscribe = page.pwragent.onHotCpuProfileCaptured((event) => {
          if (event.target !== "renderer") return;
          unsubscribe();
          resolve(event);
        });
      });

      // Every burst starts with a forced flex layout. Have the fixture
      // producing it before the first hot CPU interval can trigger a trace.
      const container = document.createElement("div");
      container.style.cssText = "position:fixed;top:0;left:0;display:flex;width:300px;";
      const child = document.createElement("div");
      child.style.flex = "1";
      child.textContent = "Trace fixture";
      container.append(child);
      document.body.append(container);
      const before = child.offsetWidth;
      container.style.width = "513px";
      const after = child.offsetWidth;
      let width = after;
      const workload = setInterval(() => {
        const deadline = performance.now() + 8;
        do {
          for (let i = 0; i < 8; i += 1) {
            container.style.width = width === 513 ? "300px" : "513px";
            width = child.offsetWidth;
          }
          for (let i = 0; i < 128; i += 1) performance.mark(privateMark);
          performance.clearMarks(privateMark);
        } while (performance.now() < deadline);
      }, 16);
      setTimeout(() => { clearInterval(workload); container.remove(); }, 25_000);

      await page.pwragent.writeSettingsConfig({ patch: { general: {
        hotCpuProfilingEnabled: true,
        hotCpuProfilingCaptureChromiumTrace: true,
      } } });
      return [before, after];
    }, marker);
    expect(widths).toEqual([300, 513]);
    const event = await app.window.evaluate(() =>
      (window as unknown as { profile: Promise<HotCpuProfileCapturedEvent> }).profile);
    const events = (await readFile(path.join(event.sessionDirectory, "events.ndjson"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const started = events.find((entry) => entry.type === "profile-started");
    expect(started?.detail).toMatchObject({ pid: expect.any(Number) });
    const exported = events.find((entry) => entry.type === "chromium-trace-written");
    expect(exported?.detail).toMatchObject({
      triggeredAt: expect.any(String),
      recordingStoppedAtMs: expect.any(Number),
      filterCpuMs: expect.any(Number),
      filterElapsedMs: expect.any(Number),
    });
    expect(Math.abs(exported.detail.recordingStoppedAtMs - Date.parse(exported.detail.triggeredAt))).toBeLessThan(2_000);
    expect(Date.parse(event.capturedAt) - exported.detail.recordingStoppedAtMs).toBeGreaterThan(2_000);
    const profile = JSON.parse(await readFile(event.profilePath, "utf8"));
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(event.chromiumTracePath).toBeDefined();
    const trace = await readFile(event.chromiumTracePath!, "utf8");
    expect(trace.includes(marker)).toBe(false);
    const timing = JSON.parse(trace).traceEvents as { pid: number; name: string }[];
    const rendererEvents = timing.filter((entry) => entry.pid === started.detail.pid);
    expect(rendererEvents.filter((entry) => entry.name === "Layout").length,
      `profiled renderer recorded ${rendererEvents.length} of ${timing.length} trace events`).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
