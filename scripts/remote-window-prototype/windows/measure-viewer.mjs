// Run in an isolated browser profile. Import only the explicitly supplied fixture batch.
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [viewerArg, batchArg, outputArg] = process.argv.slice(2);
if (!viewerArg || !batchArg || !outputArg) {
  throw new Error("Usage: node measure-viewer.mjs VIEWER_HTML PWRWIN_BATCH OUTPUT_DIR");
}
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
console.log("Playwright loaded; launching isolated Edge headless.");
const viewer = resolve(viewerArg), batchPath = resolve(batchArg), output = resolve(outputArg);
if (!basename(batchPath).startsWith("pwrwin-") || !batchPath.endsWith(".json")) {
  throw new Error("Only explicitly named pwrwin-*.json fixture batches are accepted");
}
const batch = JSON.parse(await readFile(batchPath, "utf8"));
await mkdir(output, { recursive: true });
const browser = await chromium.launchPersistentContext(join(output, "browser-profile"), {
  executablePath: process.env.EDGE_EXE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
  chromiumSandbox: true,
  viewport: { width: Math.max(1100, batch.width + 64), height: Math.max(900, batch.height + 300) },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  timeout: 20000,
});
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(viewer).href);
  const importStart = performance.now();
  await page.locator("#file").setInputFiles(batchPath);
  await page.locator("#play").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("play").disabled);
  const importMs = performance.now() - importStart;
  await page.locator("#canvas").screenshot({ path: join(output, "canvas-first.png") });
  await page.locator("#play").click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "Playback complete", null, { timeout: 60000 });
  await page.locator("#canvas").screenshot({ path: join(output, "canvas-last.png") });
  const downloadReady = page.waitForEvent("download");
  await page.locator("#save").click();
  const download = await downloadReady;
  const rawPath = join(output, "windows-viewer-raw.json");
  await download.saveAs(rawPath);
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const result = {
    ...raw,
    batchFile: basename(batchPath),
    batchBytes: (await stat(batchPath)).size,
    importMs,
    environment: "Windows Edge headless, isolated profile; desktop session disconnected",
    transport: "Already received through enrolled Federation file_push; store-and-forward, not streaming",
    captureToDisplayLatency: null,
    note: "Decode/draw uses browser performance.now. rAF is not a photon measurement. Transfer time measured by sender separately.",
  };
  await writeFile(join(output, "windows-viewer-benchmark.json"), JSON.stringify(result, null, 2) + "\n");
  const { measurements: _measurements, ...summary } = result;
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}
