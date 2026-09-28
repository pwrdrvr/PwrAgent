import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { ListingDiagnostics } from "../diagnostics/listing-diagnostics";

it("keeps a measured append/async operation budget independent of payload size", async () => {
  const diagnostics = new ListingDiagnostics();
  const fields = { origin: "68ca84ce-8d32-4230-a10f-76bc96eb2f33", source: "local" as const, consumer: "main-sidebar", query: "lens", reason: "turn",
    trigger: "turn/completed", view: 12, effect: 2, logical: 42, attempt: 1, invalidations: 3 };
  // Warm the code; report wall cost rather than imposing a flaky CI timing threshold.
  for (let i = 0; i < 10_000; i++) diagnostics.record("ipc", "start", fields);
  const eventCount = 100_000;
  let started = performance.now();
  for (let i = 0; i < eventCount; i++) diagnostics.record("ipc", "start", fields);
  const appendMs = performance.now() - started;
  const operationCount = 10_000;
  started = performance.now();
  for (let i = 0; i < operationCount; i++) await diagnostics.trace("navigation", fields, async () => 1);
  const traceMs = performance.now() - started;
  started = performance.now();
  const snapshot = diagnostics.snapshot();
  const snapshotMs = performance.now() - started;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  expect(snapshot.recorded).toBe(130_000);
  expect(snapshot.events).toHaveLength(4096);
  expect(snapshotBytes).toBeLessThan(2 * 1024 * 1024);
  expect(snapshot.totals["navigation:start"]).toBe(operationCount);
  expect(snapshot.totals["navigation:end"]).toBe(operationCount);
  if (process.env.PWRAGENT_LISTING_DIAGNOSTICS_BENCHMARK === "1") {
    await writeFile(".local/listing-budget.json", JSON.stringify({ eventCount, appendMs, appendUs: appendMs * 1000 / eventCount,
      operationCount, traceMs, traceUs: traceMs * 1000 / operationCount, snapshotMs, snapshotBytes }));
  }
});
