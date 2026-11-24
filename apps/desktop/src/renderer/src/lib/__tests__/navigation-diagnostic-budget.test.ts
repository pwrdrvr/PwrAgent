import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { NavigationListingDiagnostics } from "../navigation-listing-diagnostics";

it("bounds populated serialized records without request objects or extra transport", async () => {
  const ring = new NavigationListingDiagnostics();
  ring.setEnabled(true);
  const event = { view: Number.MAX_SAFE_INTEGER, effect: Number.MAX_SAFE_INTEGER, phase: "reply" as const,
    batch: Number.MAX_SAFE_INTEGER, refreshBatch: Number.MAX_SAFE_INTEGER, resource: Number.MAX_SAFE_INTEGER,
    read: Number.MAX_SAFE_INTEGER, logical: Number.MAX_SAFE_INTEGER, attempt: 1, rows: 100,
    cause: "metadata" as const, trigger: "navigation/directoryGitStatus/updated", invalidations: 1,
    caller: "scheduled/thread-lifecycle", query: "children", source: "remote" as const,
    inventory: "owner" as const, cursor: false, waitMs: 10, coverage: "degraded" as const, range: "offset-partial" as const,
    disposition: "accepted" as const, proofPresent: true, proofAdmitted: false, unreadChanged: true, selectionUnreadChanged: false };
  const eventCount = 100_000;
  const start = performance.now();
  for (let i = 0; i < eventCount; i++) ring.record(event);
  const appendMs = performance.now() - start;
  const read = performance.now();
  const snapshot = ring.snapshot();
  const snapshotMs = performance.now() - read;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  expect(snapshot.events).toHaveLength(1024);
  expect(snapshot.recorded).toBe(eventCount);
  expect(snapshotBytes).toBeLessThan(768 * 1024);
  ring.setEnabled(false);
  ring.record(event);
  expect(ring.snapshot().recorded).toBe(0);
  if (process.env.PWRAGENT_LISTING_DIAGNOSTICS_BENCHMARK === "1") {
    await writeFile(".local/renderer-listing-budget.json", JSON.stringify({ eventCount, appendMs,
      appendUs: appendMs * 1000 / eventCount, snapshotMs, snapshotBytes }));
  }
});

it("drops unknown decision values and payloads before serializing", () => {
  const ring = new NavigationListingDiagnostics();
  ring.setEnabled(true);
  const unsafe = { view: 1, effect: 1, phase: "seen-decision", coverage: "PRIVATE PROVIDER", range: ["PRIVATE RANGE"],
    proofPresent: "PRIVATE PROOF", proofAdmitted: { path: "PRIVATE DIRECTORY" }, unreadChanged: 42, selectionUnreadChanged: "PRIVATE COUNT",
    seenDecision: "PRIVATE ACCOUNT", seenReason: "PRIVATE THREAD", disposition: "PRIVATE TITLE", page: { title: "PRIVATE PAGE" } };
  ring.record(unsafe as unknown as Parameters<typeof ring.record>[0]);
  expect(ring.snapshot().events).toEqual([{ at: expect.any(Number), view: 1, effect: 1, phase: "seen-decision" }]);
});
