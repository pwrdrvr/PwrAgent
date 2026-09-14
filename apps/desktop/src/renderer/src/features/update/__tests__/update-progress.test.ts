import { describe, expect, it } from "vitest";
import {
  downloadMeter,
  isUpdateCheckInProgress,
  updateCheckOutcomeCopy,
  updateProgressCopy,
} from "../update-progress";

describe("isUpdateCheckInProgress", () => {
  it("covers every status a check passes through before it has an answer", () => {
    expect(isUpdateCheckInProgress({ status: "checking" })).toBe(true);
    expect(
      isUpdateCheckInProgress({ status: "available", version: "1.0.0" }),
    ).toBe(true);
    expect(
      isUpdateCheckInProgress({ status: "downloading", version: "1.0.0" }),
    ).toBe(true);
  });

  it("excludes every settled one, so the live card comes down", () => {
    for (const status of [
      { status: "idle" },
      { status: "no-update", version: "1.0.0" },
      { status: "downloaded", version: "1.0.0" },
      { status: "canceled", version: "1.0.0" },
      { status: "skipped", reason: "not here" },
      { status: "error", message: "nope" },
    ] as const) {
      expect(isUpdateCheckInProgress(status)).toBe(false);
    }
  });
});

describe("updateProgressCopy", () => {
  it("sweeps while the release read is out, with nothing to cancel yet", () => {
    const copy = updateProgressCopy({ status: "checking" });

    expect(copy.eyebrow).toBe("Checking for updates");
    expect(copy.percent).toBeUndefined();
    expect(copy.cancelable).toBe(false);
  });

  it("offers Cancel as soon as a download is the thing being waited on", () => {
    // The button appears here, before any byte has moved, which is why main
    // registers its cancelable download at this same moment.
    expect(
      updateProgressCopy({ status: "available", version: "1.0.0" }).cancelable,
    ).toBe(true);
  });

  it("names the version, the percent and the bytes it is at", () => {
    const copy = updateProgressCopy({
      status: "downloading",
      version: "1.0.0",
      percent: 42,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000,
    });

    expect(copy.eyebrow).toBe("Downloading update");
    expect(copy.message).toBe("PwrAgent v1.0.0 - 42%");
    expect(copy.percent).toBe(42);
    // Byte figures come from the shared `formatByteCount`, so they round the
    // same way the federation transfer line and Star Map load card do.
    expect(copy.meter).toBe("48 MB of 113 MB - 3.1 MB/s");
    expect(copy.cancelable).toBe(true);
  });

  it("names a downgrade as a channel switch rather than an update", () => {
    // Same distinction the downloaded card draws; the progress card must not
    // describe a deliberate move back down the channel as an update.
    expect(
      updateProgressCopy({
        status: "available",
        version: "1.0.2",
        direction: "downgrade",
      }).eyebrow,
    ).toBe("Switch available");
    expect(
      updateProgressCopy({
        status: "downloading",
        version: "1.0.2",
        direction: "downgrade",
      }).eyebrow,
    ).toBe("Downloading switch");
  });

  it("falls back to the sweep when the feed reports no percent", () => {
    // A provider that sends no content length leaves electron-updater nothing
    // to compute one from; a bar pinned at 0 would read as a stalled download.
    const copy = updateProgressCopy({
      status: "downloading",
      version: "1.0.0",
    });

    expect(copy.message).toBe("PwrAgent v1.0.0");
    expect(copy.percent).toBeUndefined();
    expect(copy.meter).toBeUndefined();
  });

  it("clamps a percent the feed overshot rather than overflowing the bar", () => {
    expect(
      updateProgressCopy({
        status: "downloading",
        version: "1.0.0",
        percent: 104,
      }).percent,
    ).toBe(100);
  });
});

describe("downloadMeter", () => {
  it("drops the half it does not know", () => {
    expect(downloadMeter({ transferred: 2_048 })).toBe("2 KB transferred");
    expect(downloadMeter({ bytesPerSecond: 500 })).toBe("500 B/s");
    expect(downloadMeter({})).toBeUndefined();
  });

  it("does not divide by a total the feed reported as zero", () => {
    expect(downloadMeter({ transferred: 1_024, total: 0 })).toBe(
      "1 KB transferred",
    );
  });

  it("ignores a rate of zero rather than printing a stalled one", () => {
    // electron-updater reports 0 B/s on the first tick, before it has two
    // samples to divide.
    expect(
      downloadMeter({ transferred: 0, total: 1_024, bytesPerSecond: 0 }),
    ).toBe("0 B of 1 KB");
  });
});

describe("the clamped percent", () => {
  it("reads the same in the message as on the bar", () => {
    // A feed that overshoots must not print "104%" beside a full bar.
    const copy = updateProgressCopy({
      status: "downloading",
      version: "1.0.0",
      percent: 104,
    });

    expect(copy.percent).toBe(100);
    expect(copy.message).toBe("PwrAgent v1.0.0 - 100%");
  });
});

describe("updateCheckOutcomeCopy", () => {
  it("reports a cancel as an answer, not a failure", () => {
    const copy = updateCheckOutcomeCopy({ status: "canceled", version: "1.0.0" });

    expect(copy.eyebrow).toBe("Download canceled");
    expect(copy.message).toBe(
      "PwrAgent v1.0.0 is still available - check again to download it.",
    );
    // An error tone would put a red card in front of someone who got exactly
    // what they asked for.
    expect(copy.tone).toBe("neutral");
  });

  it("keeps the error tone for the one outcome that is a failure", () => {
    expect(
      updateCheckOutcomeCopy({ status: "error", message: "404" }),
    ).toEqual({
      eyebrow: "Update check failed",
      message: "404",
      tone: "error",
    });
  });

  it("reports an unavailable updater without dressing it as a failure", () => {
    expect(
      updateCheckOutcomeCopy({
        status: "skipped",
        reason: "Linux builds are updated by installing a newer package.",
      }),
    ).toEqual({
      eyebrow: "Updates unavailable",
      message: "Linux builds are updated by installing a newer package.",
      tone: "neutral",
    });
  });

  it("answers an up-to-date check with the version it is running", () => {
    expect(
      updateCheckOutcomeCopy({ status: "no-update", version: "0.8.0" }),
    ).toEqual({
      eyebrow: "PwrAgent is up to date",
      message: "You're running v0.8.0.",
      tone: "neutral",
    });
  });
});
