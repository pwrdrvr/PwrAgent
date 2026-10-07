import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCameraObservation } from "../../../../../shared/native-voice-camera";
import { CAMERA_AWAY_END_MS, CameraCueFilter, openVoiceCamera, type CameraDecision } from "../voice-camera";

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

  it("reports away once and does not re-report it while the operator is still gone", () => {
    const filter = new CameraCueFilter();
    const away = { ...sample, present: false };
    const cues: string[] = [];
    const see = (frame: VoiceCameraObservation, now: number) => { const cue = filter.observe(frame, now).cue; if (cue) cues.push(cue); };
    for (let now = 0; now <= 2000; now += 500) see(away, now);
    expect(cues).toEqual(["away"]);
    // A skipped or stale frame breaks continuity; the voice already knows.
    filter.resetContinuity();
    for (let now = 2500; now <= 5000; now += 500) see(away, now);
    // So does a glimpse of the operator too short to count as a return.
    see(sample, 5500);
    see(sample, 6000);
    for (let now = 6500; now <= 9000; now += 500) see(away, now);
    expect(cues).toEqual(["away"]);
    expect(filter.status).toBe("Away already reported");
  });

  it("does not flap between present and away at the edge of the frame", () => {
    const filter = new CameraCueFilter();
    const away = { ...sample, present: false };
    const neutral = { ...sample, reaction: "neutral" as const };
    const cues: string[] = [];
    let now = 0;
    const run = (frame: VoiceCameraObservation, frames: number) => {
      for (let index = 0; index < frames; index++, now += 500) {
        const cue = filter.observe(frame, now).cue;
        if (cue) cues.push(cue);
      }
    };
    run(neutral, 4);
    run(away, 4);
    // Half in frame: runs of four frames, 1.5 seconds each way.
    for (let flap = 0; flap < 6; flap++) { run(neutral, 4); run(away, 4); }
    expect(cues).toEqual(["neutral", "away"]);
    // Three seconds of steady presence confirms the return, and says so at once.
    run(neutral, 6);
    expect(cues).toEqual(["neutral", "away"]);
    run(neutral, 1);
    expect(cues).toEqual(["neutral", "away", "neutral"]);
  });

  it("keeps the 30-second end counting only sustained absence while a return is unconfirmed", () => {
    const filter = new CameraCueFilter();
    const away = { ...sample, present: false };
    for (let now = 0; now < 20_000; now += 500) filter.observe(away, now);
    filter.observe(sample, 20_000);
    for (let now = 20_500; now < 50_500; now += 500) expect(filter.observe(away, now).end).toBeUndefined();
    expect(filter.observe(away, 50_500)).toEqual({ end: true });
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
  const none = { ...sample, gesture: "none" as const, gestureConfidence: 0.95 };
  it("sends a sustained stop after two frames, bypasses vibe cooldown, and suppresses repeats the voice has not answered", () => {
    const filter = new CameraCueFilter();
    for (let now = 0; now <= 1500; now += 500) filter.observe(sample, now);
    expect(filter.observe(stop, 2000)).toEqual({});
    expect(filter.observe(stop, 2500)).toEqual({ cue: "stop" });
    expect(filter.observe(stop, 3000)).toEqual({});
    expect(filter.gestureStatus).toBe("Already sent; waiting for the voice");
    expect(filter.status).toBe("Vibe cue held for gesture");
    // Dropped and made again, with nothing from the voice in between.
    filter.observe(none, 3500);
    filter.observe(none, 4000);
    expect(filter.observe(stop, 4500)).toEqual({});
    expect(filter.observe(stop, 5000)).toEqual({});
    expect(filter.gestureStatus).toBe("Already sent; waiting for the voice");
  });

  it("does not re-send an acknowledged stop held across frames", () => {
    const filter = new CameraCueFilter();
    filter.observe(stop, 0, { voiceActivity: 3 });
    expect(filter.observe(stop, 500, { voiceActivity: 3 })).toEqual({ cue: "stop" });
    // "Okay, pausing." finishes: one new voice line, so ask once.
    expect(filter.observe(stop, 1000, { voiceActivity: 4 })).toEqual({ recheck: "stop" });
    expect(filter.settleRecheck("stop", false, { voiceActivity: 4 }, 1300)).toBeUndefined();
    expect(filter.gestureStatus).toBe("Acknowledged; waiting for the voice to move on");
    // The judged acknowledgment is not judged again, held or made afresh.
    for (let now = 1500; now <= 6000; now += 500) expect(filter.observe(stop, now, { voiceActivity: 4 })).toEqual({});
    filter.observe(none, 6500, { voiceActivity: 4 });
    filter.observe(none, 7000, { voiceActivity: 4 });
    filter.observe(stop, 7500, { voiceActivity: 4 });
    expect(filter.observe(stop, 8000, { voiceActivity: 4 })).toEqual({});
    expect(filter.status).toBe("Vibe cue held for gesture");
  });

  it("re-arms a stop or facepalm once the voice says something substantive", () => {
    // No confident vibe, so only gestures decide.
    const facepalm = { ...sample, reactionConfidence: 0.5, gesture: "face_palm" as const, gestureConfidence: 0.9 };
    for (const [gesture, frame] of [["stop", { ...stop, reactionConfidence: 0.5 }], ["face_palm", facepalm]] as const) {
      const filter = new CameraCueFilter();
      const decisions: Array<{ now: number; decision: CameraDecision }> = [];
      let now = 0;
      const run = (observation: VoiceCameraObservation, frames: number, voiceActivity: number) => {
        for (let index = 0; index < frames; index++, now += 500) {
          decisions.push({ now, decision: filter.observe(observation, now, { voiceActivity }) });
        }
      };
      run(frame, 4, 1);
      expect(decisions.filter(({ decision }) => decision.cue === gesture)).toHaveLength(1);
      // Held past a facepalm's eight-second cooldown, with the voice silent.
      run(frame, 16, 1);
      expect(decisions.filter(({ decision }) => decision.cue || decision.recheck)).toHaveLength(1);
      // "Okay, pausing." is judged a bare acknowledgment.
      decisions.length = 0;
      run(frame, 1, 2);
      expect(decisions[0]!.decision).toEqual({ recheck: gesture });
      expect(filter.settleRecheck(gesture, false, { voiceActivity: 2 }, now)).toBeUndefined();
      run(none, 2, 2);
      run(frame, 20, 2);
      expect(decisions.slice(1).every(({ decision }) => !decision.cue && !decision.recheck)).toBe(true);
      // "Deleting all the whipped cream off every apple pie instead of the clouds."
      decisions.length = 0;
      run(frame, 1, 3);
      expect(decisions[0]!.decision).toEqual({ recheck: gesture });
      expect(filter.settleRecheck(gesture, true, { voiceActivity: 3 }, decisions[0]!.now)).toBe(gesture);
      // Sent again, so the same line cannot send it a third time.
      decisions.length = 0;
      run(frame, 4, 3);
      expect(decisions.every(({ decision }) => !decision.cue && !decision.recheck)).toBe(true);
    }
  });

  it("does not ask about an ordinary gesture's repeat inside its cooldown", () => {
    const thumbsUp = { ...sample, reactionConfidence: 0.5, gesture: "thumbs_up" as const, gestureConfidence: 0.9 };
    const filter = new CameraCueFilter();
    for (let now = 0; now < 1500; now += 500) filter.observe(thumbsUp, now, { voiceActivity: 1 });
    expect(filter.observe(thumbsUp, 1500, { voiceActivity: 1 })).toEqual({ cue: "thumbs_up" });
    for (let now = 2000; now < 9500; now += 500) expect(filter.observe(thumbsUp, now, { voiceActivity: 2 })).toEqual({});
    expect(filter.gestureStatus).toBe("Eight-second gesture cooldown");
    expect(filter.observe(thumbsUp, 9500, { voiceActivity: 2 })).toEqual({ recheck: "thumbs_up" });
  });

  it("ignores a stale or superseded repeat check", () => {
    const filter = new CameraCueFilter();
    filter.observe(stop, 0);
    filter.observe(stop, 500);
    const thumbsDown = { ...sample, gesture: "thumbs_down" as const, gestureConfidence: 0.9 };
    filter.observe(thumbsDown, 1000);
    expect(filter.observe(thumbsDown, 1500)).toEqual({ cue: "thumbs_down" });
    expect(filter.settleRecheck("stop", true, { voiceActivity: 1 }, 1600)).toBeUndefined();
  });

  it("treats a gesture after the operator comes back as new", () => {
    const filter = new CameraCueFilter();
    filter.observe(stop, 0);
    expect(filter.observe(stop, 500)).toEqual({ cue: "stop" });
    const away = { ...sample, present: false };
    for (let now = 1000; now <= 2500; now += 500) filter.observe(away, now);
    for (let now = 3000; now <= 6000; now += 500) filter.observe(sample, now);
    filter.observe(stop, 6500);
    expect(filter.observe(stop, 7000)).toEqual({ cue: "stop" });
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

describe("camera head cues", () => {
  // No confident vibe, so only the head and hands decide.
  const quiet = { ...sample, reactionConfidence: 0.5 };
  const nod = { ...quiet, head: "nodding" as const, headConfidence: 0.88 };
  const shake = { ...quiet, head: "shaking" as const, headConfidence: 0.9 };
  const still = { ...quiet, head: "still" as const, headConfidence: 0.95 };
  it("sends a nod after two bursts, and not from one burst, a still head, or a single frame", () => {
    const filter = new CameraCueFilter();
    expect(filter.observe(nod, 0)).toEqual({});
    expect(filter.observe(still, 500)).toEqual({});
    expect(filter.observe(still, 1000)).toEqual({});
    expect(filter.headStatus).toBe("No head movement");
    expect(filter.observe({ ...nod, headConfidence: 0.7 }, 1500)).toEqual({});
    // A single frame is never asked about head movement.
    expect(filter.observe(quiet, 2000)).toEqual({});
    expect(filter.observe(nod, 2500)).toEqual({});
    expect(filter.observe(nod, 3000)).toEqual({ cue: "head_nod" });
    expect(filter.observe(nod, 3500)).toEqual({});
    expect(filter.headStatus).toBe("Already sent; waiting for the voice");
  });

  it("treats a head shake as urgent: past the cooldown, and holding the vibe cues", () => {
    const filter = new CameraCueFilter();
    filter.observe(nod, 0);
    expect(filter.observe(nod, 500)).toEqual({ cue: "head_nod" });
    filter.observe(shake, 1000);
    expect(filter.observe(shake, 1500)).toEqual({ cue: "head_shake" });
    // An exasperated face behind a held shake stays with the shake.
    const exasperated = { ...shake, reactionConfidence: 0.9 };
    for (let now = 2000; now <= 5000; now += 500) expect(filter.observe(exasperated, now)).toEqual({});
    expect(filter.status).toBe("Vibe cue held for gesture");
    // A nod is not urgent: inside its cooldown it waits.
    const changed = new CameraCueFilter();
    changed.observe(shake, 0);
    expect(changed.observe(shake, 500)).toEqual({ cue: "head_shake" });
    changed.observe(nod, 1000);
    expect(changed.observe(nod, 1500)).toEqual({});
    expect(changed.headStatus).toBe("Eight-second head movement cooldown");
    for (let now = 2000; now < 8500; now += 500) changed.observe(nod, now);
    expect(changed.observe(nod, 8500)).toEqual({ cue: "head_nod" });
  });

  it("keeps hands and head apart: a nod does not make a held stop new, and a stop does not swallow a nod", () => {
    const stop = { ...quiet, gesture: "stop" as const, gestureConfidence: 0.93 };
    const filter = new CameraCueFilter();
    filter.observe({ ...stop, ...still }, 0);
    expect(filter.observe({ ...still, ...stop }, 500)).toEqual({ cue: "stop" });
    filter.observe({ ...stop, head: "nodding", headConfidence: 0.88 }, 1000);
    expect(filter.observe({ ...stop, head: "nodding", headConfidence: 0.88 }, 1500)).toEqual({ cue: "head_nod" });
    // Both at once: the stop goes first, and the nod on the next burst.
    const both = new CameraCueFilter();
    const stopAndNod = { ...nod, gesture: "stop" as const, gestureConfidence: 0.93 };
    expect(both.observe(stopAndNod, 0)).toEqual({});
    expect(both.observe(stopAndNod, 500)).toEqual({ cue: "stop" });
    expect(both.headStatus).toBe("Held for gesture");
    expect(both.observe(stopAndNod, 1000)).toEqual({ cue: "head_nod" });
  });

  it("asks before repeating a nod, and routes the answer to the head", () => {
    const filter = new CameraCueFilter();
    filter.observe(nod, 0, { voiceActivity: 1 });
    expect(filter.observe(nod, 500, { voiceActivity: 1 })).toEqual({ cue: "head_nod" });
    for (let now = 1000; now < 8500; now += 500) expect(filter.observe(nod, now, { voiceActivity: 2 })).toEqual({});
    expect(filter.observe(nod, 8500, { voiceActivity: 2 })).toEqual({ recheck: "head_nod" });
    expect(filter.settleRecheck("head_nod", false, { voiceActivity: 2 }, 8800)).toBeUndefined();
    expect(filter.headStatus).toBe("Acknowledged; waiting for the voice to move on");
    expect(filter.observe(nod, 9000, { voiceActivity: 2 })).toEqual({});
    expect(filter.observe(nod, 9500, { voiceActivity: 3 })).toEqual({ recheck: "head_nod" });
    expect(filter.settleRecheck("head_nod", true, { voiceActivity: 3 }, 9800)).toBe("head_nod");
  });
});

describe("camera burst capture", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("keeps the latest four frames 100ms apart and hands them over oldest first", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const stream = { active: true, getTracks: () => [{ stop }] };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(480);
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    // Each canvas reports the beat it was last drawn on.
    let beat = 0;
    const drawn = new WeakMap<object, number>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage: () => { drawn.set(this, beat++); } } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) { return `frame-${drawn.get(this)}`; });
    const capture = await openVoiceCamera();
    // Asked before the first beat, it draws one rather than wait.
    expect(capture.frames()).toEqual(["frame-0"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(capture.frames()).toEqual(["frame-0", "frame-1", "frame-2"]);
    await vi.advanceTimersByTimeAsync(400);
    expect(capture.frames()).toEqual(["frame-3", "frame-4", "frame-5", "frame-6"]);
    capture.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(beat).toBe(7);
    expect(stop).toHaveBeenCalledOnce();
    stream.active = false;
    expect(() => capture.frames()).toThrow("Camera disconnected.");
  });
});
