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

describe("camera gesture cues", () => {
  const stop = { ...sample, gesture: "stop" as const, gestureConfidence: 0.93 };
  it("sends a sustained stop after two frames, bypasses vibe cooldown, and suppresses repeats", () => {
    const filter = new CameraCueFilter();
    for (let now = 0; now <= 1500; now += 500) filter.observe(sample, now);
    expect(filter.observe(stop, 2000)).toEqual({});
    expect(filter.observe(stop, 2500)).toEqual({ cue: "stop" });
    expect(filter.observe(stop, 3000)).toEqual({});
    expect(filter.gestureStatus).toBe("Repeated gesture suppressed");
    expect(filter.status).toBe("Vibe cue held for gesture");
    filter.observe({ ...sample, gesture: "none", gestureConfidence: 0.95 }, 3500);
    filter.observe({ ...sample, gesture: "none", gestureConfidence: 0.95 }, 4000);
    expect(filter.observe(stop, 4500)).toEqual({});
    expect(filter.observe(stop, 5000)).toEqual({ cue: "stop" });
  });
  it("does not send uncertain, absent-person, flickering or stale-frame stop gestures", () => {
    const filter = new CameraCueFilter();
    expect(filter.observe({ ...stop, presenceConfidence: 0.5 }, 0)).toEqual({});
    expect(filter.observe({ ...stop, gestureConfidence: 0.8 }, 500)).toEqual({});
    expect(filter.observe(stop, 1000)).toEqual({});
    expect(filter.observe({ ...stop, gestureConfidence: 0.5 }, 1500)).toEqual({});
    expect(filter.observe(stop, 2000)).toEqual({});
    expect(filter.observe(stop, 13_000)).toEqual({});
    expect(filter.observe({ ...stop, present: false }, 13_500).cue).not.toBe("stop");
  });
  it("debounces ordinary gestures, rate-limits changes, and lets thumbs-down bypass cooldown", () => {
    const filter = new CameraCueFilter();
    const positive = { ...sample, gesture: "double_thumbs_up" as const, gestureConfidence: 0.92 };
    filter.observe(positive, 0); filter.observe(positive, 500); filter.observe(positive, 1000);
    expect(filter.observe(positive, 1500)).toEqual({ cue: "double_thumbs_up" });
    const pointing = { ...sample, gesture: "pointing" as const, gestureConfidence: 0.95 };
    filter.observe(pointing, 2000); filter.observe(pointing, 2500); filter.observe(pointing, 3000);
    expect(filter.observe(pointing, 3500).cue).not.toBe("pointing");
    const negative = { ...sample, gesture: "thumbs_down" as const, gestureConfidence: 0.9 };
    filter.observe(negative, 4000);
    expect(filter.observe(negative, 4500)).toEqual({ cue: "thumbs_down" });
  });
});
