import { describe, expect, it } from "vitest";
import type { ManagedRuntimeProgress } from "../../../../../shared/managed-runtime-progress";
import {
  MANAGED_RUNTIME_READY_LINGER_MS,
  isManagedRuntimeProgressVisible,
  managedRuntimeDownloadMeter,
  managedRuntimeProgressCopy,
  managedRuntimeSteps,
} from "../managed-runtime-progress-copy";

const MB = 1024 * 1024;

function progress(patch: Partial<ManagedRuntimeProgress>): ManagedRuntimeProgress {
  return { runtime: "codex", phase: "downloading", updatedAt: 1_000, ...patch };
}

describe("managed runtime progress copy", () => {
  it("meters a download with bytes, rate and time left", () => {
    expect(
      managedRuntimeDownloadMeter(
        progress({
          receivedBytes: 40 * MB,
          totalBytes: 96 * MB,
          bytesPerSecond: 8 * MB,
        }),
      ),
    ).toBe("40 MB of 96 MB · 8.0 MB/s · about 7 s left");
  });

  it("trims the meter to what the feed reports", () => {
    expect(
      managedRuntimeDownloadMeter(progress({ receivedBytes: 5 * MB })),
    ).toBe("5.0 MB");
    expect(
      managedRuntimeDownloadMeter(
        progress({ receivedBytes: 5 * MB, totalBytes: 50 * MB }),
      ),
    ).toBe("5.0 MB of 50 MB");
    expect(managedRuntimeDownloadMeter(progress({}))).toBeUndefined();
  });

  it("draws a percent only when the size is known", () => {
    expect(
      managedRuntimeProgressCopy(
        progress({ receivedBytes: 25, totalBytes: 100 }),
        false,
      ).percent,
    ).toBe(25);
    // No size: the strip sweeps rather than park a bar at zero.
    expect(
      managedRuntimeProgressCopy(progress({ receivedBytes: 25 }), false).percent,
    ).toBeUndefined();
    expect(
      managedRuntimeProgressCopy(
        progress({ receivedBytes: 300, totalBytes: 100 }),
        false,
      ).percent,
    ).toBe(100);
  });

  it("marks steps done, current and waiting", () => {
    expect(
      managedRuntimeSteps(progress({ phase: "unpacking" }))?.map((step) => step.state),
    ).toEqual(["done", "done", "now", "todo"]);
    expect(
      managedRuntimeSteps(progress({ phase: "ready" }))?.map((step) => step.state),
    ).toEqual(["done", "done", "done", "done"]);
    expect(
      managedRuntimeSteps(progress({ phase: "checking" }))?.map((step) => step.state),
    ).toEqual(["now", "todo", "todo", "todo"]);
  });

  it("names the step a failure stopped in, and none for a failed check", () => {
    expect(
      managedRuntimeSteps(
        progress({ phase: "failed", failedPhase: "verifying" }),
      )?.map((step) => step.state),
    ).toEqual(["done", "failed", "todo", "todo"]);
    expect(
      managedRuntimeSteps(progress({ phase: "failed", failedPhase: "checking" })),
    ).toBeUndefined();
  });

  it("treats a failed check with an installed build as a quiet notice", () => {
    const copy = managedRuntimeProgressCopy(
      progress({
        phase: "failed",
        failedPhase: "checking",
        error: "GitHub release check failed with HTTP 503",
        fallbackTag: "v1",
      }),
      false,
    );
    expect(copy).toMatchObject({
      tone: "notice",
      eyebrow: "Could not check for updates",
      tag: "v1",
    });
    expect(copy.message).toContain("Still using the installed build.");
  });

  it("treats a failed first install as an error", () => {
    expect(
      managedRuntimeProgressCopy(
        progress({ phase: "failed", failedPhase: "verifying", error: "Checksum mismatch" }),
        false,
      ),
    ).toMatchObject({ tone: "error", eyebrow: "Download failed" });
  });

  it("says a finished Codex build is waiting for idle when a switch is pending", () => {
    expect(
      managedRuntimeProgressCopy(progress({ phase: "ready", tag: "v2" }), true),
    ).toMatchObject({ tone: "notice", full: true });
    expect(
      managedRuntimeProgressCopy(progress({ phase: "ready", tag: "v2" }), false),
    ).toMatchObject({ tone: "ok", eyebrow: "Installed" });
  });

  it("lets a finished strip go after its linger, and keeps a failure up", () => {
    const ready = progress({ phase: "ready" });
    expect(isManagedRuntimeProgressVisible(ready, 1_000 + 1)).toBe(true);
    expect(
      isManagedRuntimeProgressVisible(ready, 1_000 + MANAGED_RUNTIME_READY_LINGER_MS),
    ).toBe(false);
    expect(
      isManagedRuntimeProgressVisible(
        progress({ phase: "failed" }),
        1_000 + 10 * MANAGED_RUNTIME_READY_LINGER_MS,
      ),
    ).toBe(true);
    expect(isManagedRuntimeProgressVisible(progress({ phase: "idle" }), 1_000)).toBe(false);
  });
});
