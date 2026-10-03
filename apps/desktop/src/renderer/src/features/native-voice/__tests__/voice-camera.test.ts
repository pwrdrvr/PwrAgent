import { describe, expect, it } from "vitest";
import type { VoiceCameraObservation } from "../../../../../shared/native-voice-camera";
import { CAMERA_AWAY_END_MS, CameraCueFilter } from "../voice-camera";

const sample: VoiceCameraObservation = {
  present: true, presenceConfidence: 0.95, reaction: "exasperated", reactionConfidence: 0.9, latencyMs: 400,
};

describe("camera cue debounce", () => {
  it("delivers the first sustained neutral cue once so voice receives baseline context", () => {
    const filter = new CameraCueFilter();
    const neutral = { ...sample, reaction: "neutral" as const };
    expect(filter.observe(neutral, 0)).toEqual({});
    expect(filter.observe(neutral, 500)).toEqual({});
    expect(filter.observe(neutral, 1500)).toEqual({ cue: "neutral" });
    expect(filter.observe(neutral, 2000)).toEqual({});
    expect(filter.status).toBe("Repeated cue suppressed");
  });

  it("requires sustained confident samples and deduplicates the same reaction", () => {
    const filter = new CameraCueFilter();
    expect(filter.observe(sample, 0)).toEqual({});
    expect(filter.observe(sample, 500)).toEqual({});
    expect(filter.observe(sample, 1000)).toEqual({});
    expect(filter.observe(sample, 1500)).toEqual({ cue: "exasperated" });
    expect(filter.observe(sample, 20_000)).toEqual({});
    expect(filter.observe(sample, 22_000)).toEqual({});
  });

  it("rejects flicker and uncertain reactions, and rate limits sustained changes", () => {
    const filter = new CameraCueFilter();
    filter.observe(sample, 0);
    filter.observe(sample, 500);
    filter.observe({ ...sample, reactionConfidence: 0.5 }, 1000);
    expect(filter.observe(sample, 1500)).toEqual({});
    filter.observe(sample, 2000);
    expect(filter.observe(sample, 3000)).toEqual({ cue: "exasperated" });
    const smile = { ...sample, reaction: "enthusiastic" as const };
    filter.observe(smile, 3500);
    filter.observe(smile, 4000);
    expect(filter.observe(smile, 5000)).toEqual({});
    for (let now = 5500; now < 11_000; now += 500) filter.observe(smile, now);
    expect(filter.observe(smile, 11_000)).toEqual({ cue: "enthusiastic" });
  });

  it("ends only after 30 seconds of continuously confident absence", () => {
    const filter = new CameraCueFilter();
    const away = { ...sample, present: false };
    for (let now = 0; now < CAMERA_AWAY_END_MS; now += 500) expect(filter.observe(away, now).end).toBeUndefined();
    expect(filter.observe(away, CAMERA_AWAY_END_MS)).toEqual({ end: true });
  });

  it("resets the absence countdown on return, uncertainty, and stale samples", () => {
    for (const interruption of [sample, { ...sample, present: false, presenceConfidence: 0.5 }]) {
      const filter = new CameraCueFilter();
      const away = { ...sample, present: false };
      for (let now = 0; now < 29_000; now += 500) filter.observe(away, now);
      filter.observe(interruption, 29_000);
      expect(filter.observe(away, 30_000).end).toBeUndefined();
    }
    const filter = new CameraCueFilter();
    filter.observe({ ...sample, present: false }, 0);
    expect(filter.observe({ ...sample, present: false }, 31_000).end).toBeUndefined();
  });
});
