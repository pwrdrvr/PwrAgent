import { describe, expect, it } from "vitest";
import { RendererUpdateEvent } from "../../../../shared/renderer-update-diagnostics";
import { createRendererUpdateRecorder } from "../renderer-update-diagnostics";

describe("renderer update recorder", () => {
  it("coalesces repeated edges and retains lifetime counts after wrapping", () => {
    let now = 0;
    const recorder = createRendererUpdateRecorder(() => now);
    for (let index = 0; index < 100; index += 1) {
      now += 1;
      recorder.record(RendererUpdateEvent.tooltipHide, "_r_0_");
    }
    expect(recorder.snapshot().events).toEqual([{
      event: RendererUpdateEvent.tooltipHide, scope: "_r_0_", firstMs: 1, lastMs: 100, count: 100,
    }]);
    for (let index = 0; index < 100; index += 1) {
      now += 1;
      recorder.record(index % 2 ? RendererUpdateEvent.editorPublish : RendererUpdateEvent.composerChange);
    }
    const snapshot = recorder.snapshot();
    expect(snapshot.events).toHaveLength(64);
    expect(snapshot.events[0].firstMs).toBe(137);
    expect(snapshot.events[63].lastMs).toBe(200);
    expect(snapshot.total).toBe(200);
    expect(snapshot.counts[RendererUpdateEvent.tooltipHide]).toBe(100);
    expect(snapshot.counts[RendererUpdateEvent.editorPublish]).toBe(50);
  });

  it("returns detached snapshots and keeps storage fixed during sustained updates", () => {
    const recorder = createRendererUpdateRecorder(() => 1);
    recorder.record(RendererUpdateEvent.editorPublish);
    const first = recorder.snapshot();
    first.events[0].count = 999;
    first.counts[0] = 999;
    for (let index = 0; index < 100_000; index += 1) {
      recorder.record(RendererUpdateEvent.editorPublish);
    }
    expect(recorder.snapshot().events).toHaveLength(1);
    expect(recorder.snapshot().events[0].count).toBe(100_001);
    expect(recorder.storageBytes).toBeLessThanOrEqual(2048);
    expect(recorder.snapshot()).not.toHaveProperty("draft");
  });
});
