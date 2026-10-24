import {
  VOICE_CAMERA_BURST,
  type CameraCue, type CameraGesture, type CameraHeadCue, type CameraHeadMotion, type VoiceCameraObservation,
} from "../../../../shared/native-voice-camera";

export const CAMERA_AWAY_END_MS = 30_000;
export const CAMERA_SAMPLE_GAP_MS = 10_000;
const REACTION_DEBOUNCE_MS = 1500;
const CUE_COOLDOWN_MS = 8000;
/**
 * Once away has been reported, the operator counts as back only after this
 * long of consecutive confident presence. Leaving takes 1.5 seconds, so an
 * operator half out of frame does not flip present and away on each frame.
 */
const PRESENCE_RETURN_MS = 3000;
const PRESENCE_RETURN_SAMPLES = 4;
/** A cue the operator makes on purpose: a hand gesture, a nod, or a head shake. */
export type CameraGestureCue = Exclude<CameraGesture, "none"> | CameraHeadCue;
/** `recheck`: a gesture already sent is back; ask whether the voice has moved on before sending it again. */
export type CameraDecision = { cue?: CameraCue; end?: boolean; recheck?: CameraGestureCue };
/** What the voice has said so far: completed spoken lines, counted by the controller. */
export type CameraCueContext = { voiceActivity: number };

const HEAD_CUES: Record<CameraHeadMotion, CameraHeadCue | undefined> = { nodding: "head_nod", shaking: "head_shake", still: undefined };
/** A pause or a "no": stricter confidence, and no cooldown. */
const isUrgent = (cue: CameraGestureCue) => cue === "stop" || cue === "thumbs_down" || cue === "head_shake";

/**
 * One kind of deliberate signal, hands or head, each with its own debounce,
 * cooldown and record of what was sent: a nod must not make a held stop
 * look new.
 */
class GestureTrack {
  status: string;
  private candidate?: string;
  private since = 0;
  private samples = 0;
  private lastSent = -Infinity;
  /**
   * The last cue handed to the voice, and how much the voice had said when
   * it was sent or last judged. The same cue is not sent again until the
   * voice says something after that, and the conversation check says it was
   * more than an acknowledgment.
   */
  private sent?: { cue: CameraGestureCue; voiceActivity: number };
  constructor(private readonly noun: string, private readonly nothing: string) {
    this.status = `Waiting for a ${noun.toLowerCase()} decision`;
  }

  reset(status?: string): void {
    this.candidate = undefined;
    this.samples = 0;
    if (status) this.status = status;
  }
  /** A gesture after the operator comes back is new, not a repeat. */
  forget(): void { this.sent = undefined; }
  owns(cue: CameraGestureCue): boolean { return this.sent?.cue === cue; }

  /**
   * `pick` is the model's answer and `cue` what it means, or undefined for
   * "nothing". `quick` asks for two samples over 500ms instead of three over
   * 1.5 seconds.
   */
  observe(pick: string | undefined, confidence: number, cue: CameraGestureCue | undefined, quick: boolean, now: number, context: CameraCueContext): CameraDecision {
    const threshold = cue && isUrgent(cue) ? 0.85 : 0.8;
    if (!pick || confidence < threshold) {
      this.reset(`${this.noun} confidence below ${threshold * 100}%`);
      return {};
    }
    if (pick !== this.candidate) {
      this.candidate = pick;
      this.since = now;
      this.samples = 0;
    }
    this.samples++;
    this.status = `Collecting consecutive ${this.noun.toLowerCase()} frames`;
    if (this.samples < (quick ? 2 : 3) || now - this.since < (quick ? 500 : REACTION_DEBOUNCE_MS)) return {};
    if (!cue) { this.status = this.nothing; return {}; }
    if (cue === this.sent?.cue) {
      // Held, or made again. Nothing the voice has said since can be news.
      if (context.voiceActivity <= this.sent.voiceActivity) { this.status = "Already sent; waiting for the voice"; return {}; }
      // Inside the cooldown a "moved on" answer could not send it anyway.
      if (!isUrgent(cue) && now - this.lastSent < CUE_COOLDOWN_MS) { this.status = `Eight-second ${this.noun.toLowerCase()} cooldown`; return {}; }
      this.status = "Asking whether the voice moved on";
      return { recheck: cue };
    }
    const released = this.release(cue, now, context);
    return released ? { cue: released } : {};
  }

  settle(cue: CameraGestureCue, movedOn: boolean, context: CameraCueContext, now: number): CameraCue | undefined {
    if (this.sent?.cue !== cue) return;
    if (!movedOn) {
      this.sent = { cue, voiceActivity: context.voiceActivity };
      this.status = "Acknowledged; waiting for the voice to move on";
      return;
    }
    return this.release(cue, now, context);
  }

  private release(cue: CameraGestureCue, now: number, context: CameraCueContext): CameraCue | undefined {
    if (!isUrgent(cue) && now - this.lastSent < CUE_COOLDOWN_MS) { this.status = `Eight-second ${this.noun.toLowerCase()} cooldown`; return; }
    this.sent = { cue, voiceActivity: context.voiceActivity };
    this.lastSent = now;
    this.status = `${this.noun} cue ready`;
    return cue;
  }
}

const signalled = (decision: CameraDecision) => decision.cue !== undefined || decision.recheck !== undefined;

/** Require consecutive confident samples; missing/uncertain frames never count as absence. */
export class CameraCueFilter {
  status = "Waiting for a decision";
  private readonly hand = new GestureTrack("Gesture", "No gesture");
  private readonly head = new GestureTrack("Head movement", "No head movement");
  private candidate?: CameraCue;
  private since = 0;
  private samples = 0;
  private lastSample?: number;
  private lastCue?: CameraCue;
  private lastSent = -Infinity;
  private awaySince?: number;
  /** What the voice was last told about presence. Survives lost continuity: it is a fact about the conversation. */
  private presence: "present" | "away" = "present";
  private returnSince?: number;
  private returnSamples = 0;

  get gestureStatus(): string { return this.hand.status; }
  get headStatus(): string { return this.head.status; }

  resetContinuity(): void {
    this.awaySince = undefined;
    this.candidate = undefined;
    this.lastSample = undefined;
    this.hand.reset();
    this.head.reset();
    this.returnSince = undefined;
    this.returnSamples = 0;
  }

  observe(observation: VoiceCameraObservation, now: number, context: CameraCueContext = { voiceActivity: 0 }): CameraDecision {
    if (this.lastSample !== undefined && now - this.lastSample > CAMERA_SAMPLE_GAP_MS) this.resetContinuity();
    const confident = observation.present && observation.presenceConfidence >= 0.8;
    let hand: CameraDecision = {};
    let head: CameraDecision = {};
    if (confident) {
      const gesture = observation.gesture;
      const cue = gesture === "none" ? undefined : gesture;
      hand = this.hand.observe(gesture, observation.gestureConfidence ?? 0, cue, !cue || isUrgent(cue), now, context);
      // Hands first: a stop outranks a nod made at the same moment. The head
      // track is not advanced this time, so a nod it would have sent is not
      // recorded as sent; it is ready again on the next burst.
      if (signalled(hand)) {
        this.head.status = "Held for gesture";
      } else {
        // A burst already spans the motion, so two in a row are enough.
        const motion = observation.head;
        head = this.head.observe(motion, observation.headConfidence ?? 0, motion && HEAD_CUES[motion], true, now, context);
      }
    } else {
      this.hand.reset("Gesture requires confident presence");
      this.head.reset("Head movement requires confident presence");
    }
    // A stop, thumbs-down or head shake still showing holds the vibe cues,
    // even while its own cue is suppressed as a repeat.
    const urgentHeld = confident && (
      ((observation.gesture === "stop" || observation.gesture === "thumbs_down") && (observation.gestureConfidence ?? 0) >= 0.85)
      || (observation.head === "shaking" && (observation.headConfidence ?? 0) >= 0.85));
    const decision = this.observeReaction(observation, now, signalled(hand) || signalled(head) || urgentHeld);
    if (signalled(hand)) return hand;
    if (signalled(head)) return head;
    return decision;
  }

  /**
   * The conversation check's answer for a `recheck`. `context` is what the
   * voice had said when the conversation was read, so a line judged a bare
   * acknowledgment is not judged again.
   */
  settleRecheck(gesture: CameraGestureCue, movedOn: boolean, context: CameraCueContext, now: number): CameraCue | undefined {
    const track = this.hand.owns(gesture) ? this.hand : this.head.owns(gesture) ? this.head : undefined;
    return track?.settle(gesture, movedOn, context, now);
  }

  private observeReaction(observation: VoiceCameraObservation, now: number, holdReaction: boolean): CameraDecision {
    this.lastSample = now;
    this.status = "Collecting consecutive frames";
    if (observation.presenceConfidence < 0.8) {
      this.status = "Presence confidence below 80%";
      this.awaySince = undefined;
      this.candidate = undefined;
      this.returnSince = undefined;
      this.returnSamples = 0;
      return {};
    }
    let cue: CameraCue;
    if (!observation.present) {
      this.returnSince = undefined;
      this.returnSamples = 0;
      this.awaySince ??= now;
      if (now - this.awaySince >= CAMERA_AWAY_END_MS) return { end: true };
      if (this.presence === "away") { this.status = "Away already reported"; this.candidate = undefined; return {}; }
      cue = "away";
    } else {
      // Any confident sight of the operator restarts the 30-second countdown,
      // even before their return is confirmed: only sustained absence ends voice.
      this.awaySince = undefined;
      let returning = false;
      if (this.presence === "away") {
        this.returnSince ??= now;
        this.returnSamples++;
        returning = this.returnSamples < PRESENCE_RETURN_SAMPLES || now - this.returnSince < PRESENCE_RETURN_MS;
        if (!returning) { this.presence = "present"; this.returnSince = undefined; this.returnSamples = 0; }
      }
      if (observation.reactionConfidence < 0.7) {
        this.status = returning ? "Confirming return" : "Reaction confidence below 70%";
        this.candidate = undefined;
        return {};
      }
      cue = observation.reaction;
      // The return's frames still build the next vibe, so it can follow at once.
      if (returning) { this.track(cue, now); this.status = "Confirming return"; return {}; }
    }
    if (holdReaction) { this.status = "Vibe cue held for gesture"; return {}; }
    this.track(cue, now);
    if (this.samples < 3 || now - this.since < REACTION_DEBOUNCE_MS) return {};
    if (cue === this.lastCue) { this.status = "Repeated cue suppressed"; return {}; }
    if (cue !== "away" && this.lastCue !== "away" && now - this.lastSent < CUE_COOLDOWN_MS) { this.status = "Eight-second cue cooldown"; return {}; }
    this.lastCue = cue;
    this.lastSent = now;
    this.status = "Cue ready";
    if (cue === "away") {
      this.presence = "away";
      // A gesture made after the operator comes back is new, not a repeat.
      this.hand.forget();
      this.head.forget();
    }
    return { cue };
  }

  private track(cue: CameraCue, now: number): void {
    if (cue !== this.candidate) {
      this.candidate = cue;
      this.since = now;
      this.samples = 0;
    }
    this.samples++;
  }
}

/** `frames()` returns the latest burst, oldest first: up to `VOICE_CAMERA_BURST.frames`, `spacingMs` apart. */
export type CameraCapture = { stream: MediaStream; frames: () => string[]; close: () => void };
export async function openVoiceCamera(): Promise<CameraCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 336 }, height: { ideal: 252 }, facingMode: "user" } });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // The latest frames, drawn on a fixed beat and encoded only when a request
  // takes them, so a burst never waits on the camera.
  const { frames: size, spacingMs } = VOICE_CAMERA_BURST;
  const ring = Array.from({ length: size }, () => document.createElement("canvas"));
  const contexts = ring.map((canvas) => canvas.getContext("2d"));
  let next = 0;
  let filled = 0;
  const draw = (): boolean => {
    if (!video.videoWidth || video.readyState < 2) return false;
    const scale = Math.min(1, 336 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = ring[next]!;
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    // Resizing a canvas reallocates it; the camera's size rarely changes.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    contexts[next]!.drawImage(video, 0, 0, width, height);
    next = (next + 1) % size;
    filled = Math.min(filled + 1, size);
    return true;
  };
  const timer = setInterval(draw, spacingMs);
  const close = () => {
    clearInterval(timer);
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
  };
  if (contexts.some((context) => !context)) { close(); throw new Error("Camera capture is unavailable."); }
  try { await video.play(); } catch (error) { close(); throw error; }
  return {
    stream, close,
    frames: () => {
      if (!stream.active) throw new Error("Camera disconnected.");
      if (filled === 0 && !draw()) return [];
      return Array.from({ length: filled }, (_, index) => ring[(next - filled + index + size) % size]!.toDataURL("image/jpeg", 0.8));
    },
  };
}
