import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

// Opt in on both revisions with the same fixture and built-app settings.
// Timings include the renderer/preload/IPC round trip; no assertion gates noisy host timing.
test("measures native sidebar owner reads over the renderer bridge", async ({ browserName: _browserName }, testInfo) => {
  const label = process.env.PWRAGENT_NAVIGATION_BENCHMARK;
  test.skip(!label, "Set PWRAGENT_NAVIGATION_BENCHMARK to an artifact label to measure native navigation.");
  if (!/^[a-z0-9-]+$/.test(label!)) throw new Error("Use a lowercase alphanumeric benchmark label.");
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-navigation-latency-"));
  const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures/smoke/replay.fixture.json"), "utf8"));
  const listing = fixture.steps.find((step: { method?: string }) => step.method === "thread/list");
  const original = listing.result[0];
  listing.result = [original, ...Array.from({ length: 999 }, (_, index) => ({ ...original,
    id: `benchmark-${index}`, title: `Benchmark thread ${index}`, updatedAt: original.updatedAt - index - 1 }))];
  const fixturePath = path.join(root, "replay.fixture.json");
  await writeFile(fixturePath, JSON.stringify(fixture));
  const app = await launchElectronApp({ fixturePath });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByRole("heading", { level: 2, name: "Replay smoke thread" })).toBeVisible();
    const measurements = await app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const rows = [];
      try {
        for (const scenario of ["warm", "changed-query"] as const) {
          const samples: number[] = [];
          for (let index = 0; index < 120; index += 1) {
            const start = performance.now();
            const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", inventory: "viewer",
              query: { kind: "lens", lens: "inbox", ...(scenario === "changed-query" ? { filter: String(index) } : {}) } }, "native-benchmark");
            if (page.protocol !== 2) throw new Error("Expected the bounded owner navigation protocol.");
            if (index >= 20) samples.push(performance.now() - start);
          }
          samples.sort((left, right) => left - right);
          rows.push({ scenario, threads: 1000, samples: samples.length, p50Ms: samples[50], p95Ms: samples[95],
            totalMs: samples.reduce((sum, value) => sum + value, 0) });
        }
      } finally { await api.releaseNavigationQuery!("native-benchmark"); }
      return rows;
    });
    const output = path.join(import.meta.dirname, "../.local", `navigation-owner-latency-${label}.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(measurements, null, 2) + "\n");
    await testInfo.attach("native-navigation-latency", { path: output, contentType: "application/json" });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
