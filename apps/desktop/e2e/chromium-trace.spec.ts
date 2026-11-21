import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { ChromiumTrace } from "../src/main/diagnostics/chromium-trace";
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
        entryPoints: [path.join(here, "../src/main/diagnostics/chromium-trace.ts")],
        outfile: controller, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
      });
    },
  });
  const artifact = info.outputPath("renderer.trace.json");
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
      const { ChromiumTrace: Trace } = require(args.controller) as { ChromiumTrace: typeof ChromiumTrace };
      const fs = require("node:fs/promises") as typeof import("node:fs/promises");
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const target = new BrowserWindow({ width: 640, height: 480, webPreferences: { backgroundThrottling: false } });
      const warnings: string[] = [];
      let raw = "";
      try {
        async function run(useOldKey: boolean) {
          await target.loadURL(args.origin);
          const trace = new Trace(() => ({
            startRecording: (config) => {
              if (!useOldKey) return contentTracing.startRecording(config);
              const { record_mode, ...rest } = config;
              return contentTracing.startRecording({ ...rest, recording_mode: record_mode });
            },
            async stopRecording(file) {
              const written = await contentTracing.stopRecording(file);
              raw = await fs.readFile(written, "utf8");
              return written;
            },
          }), (message) => warnings.push(message), { bufferSizeKb: 1024 });
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
            const events: { name?: string }[] = JSON.parse(raw).traceEvents;
            return {
              capture,
              early: events.some((event) => event.name === "early-overflow-marker"),
              recent: events.some((event) => event.name === "recent-overflow-marker"),
              hadPrivateUrl: raw.includes(args.url),
              widths,
            };
          } finally {
            await trace.release(owner);
          }
        }
        const old = await run(true);
        const rolling = await run(false);
        return { old, rolling, warnings, electron: process.versions.electron, chromium: process.versions.chrome };
      } finally {
        target.destroy();
      }
    }, { controller, artifact, origin, privateValue, url });

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
