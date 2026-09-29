import { describe, expect, it } from "vitest";
import type { ManagedRuntimeProgress } from "../../shared/managed-runtime-progress";
import {
  createManagedRuntimeProgressReporter,
  readManagedRuntimeProgress,
  subscribeManagedRuntimeProgress,
} from "../managed-runtime-progress";

function collect(runtime: "codex" | "grok"): {
  events: ManagedRuntimeProgress[];
  stop: () => void;
} {
  const events: ManagedRuntimeProgress[] = [];
  const stop = subscribeManagedRuntimeProgress((event) => {
    if (event.runtime === runtime) events.push(event);
  });
  return { events, stop };
}

describe("managed runtime progress reporter", () => {
  it("throttles byte updates and smooths the rate", () => {
    let clock = 0;
    const { events, stop } = collect("codex");
    const reporter = createManagedRuntimeProgressReporter("codex", () => clock);
    const onBytes = reporter.downloading("tag-1", 10_000);

    // A burst inside one interval reports once, at the opening state only.
    for (let index = 0; index < 50; index += 1) {
      clock += 2;
      onBytes(100);
    }
    expect(events).toHaveLength(1);

    clock += 300;
    onBytes(1_000);
    stop();

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      phase: "downloading",
      tag: "tag-1",
      receivedBytes: 6_000,
      totalBytes: 10_000,
    });
    expect(events[1]?.bytesPerSecond).toBeGreaterThan(0);
  });

  it("keeps the latest state for a window that opens mid-download", () => {
    const reporter = createManagedRuntimeProgressReporter("grok", () => 5);
    reporter.checking();
    reporter.verifying("v1");

    expect(
      readManagedRuntimeProgress().find((entry) => entry.runtime === "grok"),
    ).toMatchObject({ phase: "verifying", tag: "v1", updatedAt: 5 });

    reporter.idle();
    expect(
      readManagedRuntimeProgress().find((entry) => entry.runtime === "grok"),
    ).toBeUndefined();
  });

  it("blames the phase that was running when the install failed", () => {
    const { events, stop } = collect("codex");
    const reporter = createManagedRuntimeProgressReporter("codex", () => 1);
    reporter.checking();
    reporter.unpacking("v2");
    reporter.failed(new Error("tar exited 1"), { tag: "v2", fallbackTag: "v1" });
    stop();

    expect(events.at(-1)).toMatchObject({
      phase: "failed",
      failedPhase: "unpacking",
      error: "tar exited 1",
      fallbackTag: "v1",
    });
  });

  it("survives a subscriber that throws", () => {
    const stop = subscribeManagedRuntimeProgress(() => {
      throw new Error("broken listener");
    });
    const reporter = createManagedRuntimeProgressReporter("codex", () => 1);
    expect(() => reporter.checking()).not.toThrow();
    stop();
    reporter.idle();
  });
});
