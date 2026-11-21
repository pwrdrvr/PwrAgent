import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ChromiumTrace } from "../src/main/diagnostics/chromium-trace";
import type { chromiumTracePublisher } from "../src/main/diagnostics/chromium-trace-publisher";
import type { createChromiumTraceSession } from "../src/main/shell/diagnostics/chromium-trace-session";
import { launchElectronApp } from "./fixtures/electron-app";
import { expect, test } from "./fixtures/electron-test";

const here = path.dirname(fileURLToPath(import.meta.url));

test("native rolling trace evicts old events and publishes only filtered timing data", async () => {
  const info = test.info();
  test.setTimeout(90_000);
  let controller = "";
  const app = await launchElectronApp({
    fixturePath: path.join(here, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      controller = path.join(homeRoot, "production-chromium-trace.cjs");
      await build({
        stdin: {
          contents: `
            export { ChromiumTrace } from "./diagnostics/chromium-trace";
            export { chromiumTracePublisher } from "./diagnostics/chromium-trace-publisher";
            export { createChromiumTraceSession } from "./shell/diagnostics/chromium-trace-session";
          `,
          resolveDir: path.join(here, "../src/main"),
        },
        outfile: controller, bundle: true, platform: "node", format: "cjs",
        external: ["electron"], logLevel: "silent",
      });
    },
  });
  const artifact = info.outputPath("renderer.trace.json");
  const externalFile = path.join(app.homeRoot, "external-oracle.json");
  const worker = path.join(here, "../out/main/chromium-trace-worker.js");
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
        ChromiumTrace: Trace, createChromiumTraceSession: createSession, chromiumTracePublisher: createPublisher,
      } = require(args.controller) as {
        ChromiumTrace: typeof ChromiumTrace;
        createChromiumTraceSession: typeof createChromiumTraceSession;
        chromiumTracePublisher: typeof chromiumTracePublisher;
      };
      const fs = require("node:fs/promises") as typeof import("node:fs/promises");
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const target = new BrowserWindow({ width: 640, height: 480, webPreferences: { backgroundThrottling: false } });
      const warnings: string[] = [];
      const publish = createPublisher(args.worker);
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
          let publishError = "";
          const trace = new Trace(() => {
            const session = createSession();
            return {
              ...session,
              start: (config) => session.start(untilFull ? { ...config, recordMode: "recordUntilFull" } : config),
              async *read(signal) {
                for await (const chunk of session.read(signal)) {
                  raw.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
                  yield chunk;
                }
              },
            };
          }, async (...params) => {
            try {
              await publish(...params);
            } catch (error) {
              // This probe records only a contrived page and fixture paths.
              publishError = String(error);
              throw error;
            }
          }, (message) => warnings.push(message), { bufferSizeKb: 1024 });
          const owner = {};
          try {
            await trace.arm(owner);
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
              throw new Error(`${mode} capture did not publish: ${JSON.stringify(capture)} (${raw.length} chunks, ${publishError || warnings.join(", ")})`);
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
    }, { controller, artifact, externalFile, worker, origin, privateValue, url });

    expect(result.externalConflict).toEqual({ status: "skipped", reason: "not-recording" });
    expect(result.externalStillOwned).toBe(true);
    expect(result.conflictWarnings).toEqual(["Could not arm Chromium trace"]);
    expect(result.warnings).toEqual([]);
    expect(result.old).toMatchObject({ capture: { status: "written" }, early: true, recent: false });
    expect(result.rolling).toMatchObject({
      capture: { status: "written" }, early: false, recent: true, hadPrivateUrl: true,
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
