import type { CameraCue, CameraGesture, VoiceCameraObservation } from "../../../../shared/native-voice-camera";

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
export type CameraGestureCue = Exclude<CameraGesture, "none">;
/** `recheck`: a gesture already sent is back; ask whether the voice has moved on before sending it again. */
export type CameraDecision = { cue?: CameraCue; end?: boolean; recheck?: CameraGestureCue };
/** What the voice has said so far: completed spoken lines, counted by the controller. */
export type CameraCueContext = { voiceActivity: number };

/** Require consecutive confident samples; missing/uncertain frames never count as absence. */
export class CameraCueFilter {
  status = "Waiting for a decision";
  gestureStatus = "Waiting for a gesture decision";
  private gestureCandidate?: CameraGesture;
  private gestureSince = 0;
  private gestureSamples = 0;
  private lastGestureSent = -Infinity;
  /**
   * The last gesture handed to the voice, and how much the voice had done
   * when it was sent or last judged. The same gesture is not sent again
   * until the voice does something after that, and the conversation check
   * says it was more than an acknowledgment.
   */
  private sent?: { gesture: CameraGestureCue; voiceActivity: number };
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

  resetContinuity(): void {
    this.awaySince = undefined;
    this.candidate = undefined;
    this.lastSample = undefined;
    this.gestureCandidate = undefined;
    this.gestureSamples = 0;
    this.returnSince = undefined;
    this.returnSamples = 0;
  }

  observe(observation: VoiceCameraObservation, now: number, context: CameraCueContext = { voiceActivity: 0 }): CameraDecision {
    if (this.lastSample !== undefined && now - this.lastSample > CAMERA_SAMPLE_GAP_MS) this.resetContinuity();
    let gesture: CameraDecision = {};
    if (observation.present && observation.presenceConfidence >= 0.8) {
      gesture = this.observeGesture(observation, now, context);
    } else {
      this.gestureCandidate = undefined;
      this.gestureStatus = "Gesture requires confident presence";
    }
    const stopHeld = observation.present && observation.presenceConfidence >= 0.8
      && (observation.gesture === "stop" || observation.gesture === "thumbs_down")
      && (observation.gestureConfidence ?? 0) >= 0.85;
    const decision = this.observeReaction(observation, now, gesture.cue !== undefined || gesture.recheck !== undefined || stopHeld);
    return gesture.cue || gesture.recheck ? gesture : decision;
  }

  /**
   * The conversation check's answer for a `recheck`. `context` is what the
   * voice had done when the conversation was read, so a line judged a bare
   * acknowledgment is not judged again.
   */
  settleRecheck(gesture: CameraGestureCue, movedOn: boolean, context: CameraCueContext, now: number): CameraCue | undefined {
    if (this.sent?.gesture !== gesture) return;
    if (!movedOn) {
      this.sent = { gesture, voiceActivity: context.voiceActivity };
      this.gestureStatus = "Acknowledged; waiting for the voice to move on";
      return;
    }
    return this.release(gesture, now, context);
  }

  private observeGesture(observation: VoiceCameraObservation, now: number, context: CameraCueContext): CameraDecision {
    const gesture = observation.gesture;
    const urgent = gesture === "stop" || gesture === "thumbs_down";
    const threshold = urgent ? 0.85 : 0.8;
    if (!gesture || (observation.gestureConfidence ?? 0) < threshold) {
      this.gestureCandidate = undefined;
      this.gestureStatus = `Gesture confidence below ${threshold * 100}%`;
      return {};
    }
    if (gesture !== this.gestureCandidate) {
      this.gestureCandidate = gesture;
      this.gestureSince = now;
      this.gestureSamples = 0;
    }
    this.gestureSamples++;
    this.gestureStatus = "Collecting consecutive gesture frames";
    const quick = urgent || gesture === "none";
    if (this.gestureSamples < (quick ? 2 : 3) || now - this.gestureSince < (quick ? 500 : REACTION_DEBOUNCE_MS)) return {};
    if (gesture === "none") { this.gestureStatus = "No gesture"; return {}; }
    if (gesture === this.sent?.gesture) {
      // Held, or made again. Nothing the voice has done since can be news.
      if (context.voiceActivity <= this.sent.voiceActivity) { this.gestureStatus = "Already sent; waiting for the voice"; return {}; }
      // Inside the cooldown a "moved on" answer could not send it anyway.
      if (!urgent && now - this.lastGestureSent < CUE_COOLDOWN_MS) { this.gestureStatus = "Eight-second gesture cooldown"; return {}; }
      this.gestureStatus = "Asking whether the voice moved on";
      return { recheck: gesture };
    }
    const cue = this.release(gesture, now, context);
    return cue ? { cue } : {};
  }

  private release(gesture: CameraGestureCue, now: number, context: CameraCueContext): CameraCue | undefined {
    const urgent = gesture === "stop" || gesture === "thumbs_down";
    if (!urgent && now - this.lastGestureSent < CUE_COOLDOWN_MS) { this.gestureStatus = "Eight-second gesture cooldown"; return; }
    this.sent = { gesture, voiceActivity: context.voiceActivity };
    this.lastGestureSent = now;
    this.gestureStatus = "Gesture cue ready";
    return gesture;
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
      this.sent = undefined;
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

export type CameraCapture = { stream: MediaStream; frame: () => string | undefined; close: () => void };
export async function openVoiceCamera(): Promise<CameraCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 336 }, height: { ideal: 252 }, facingMode: "user" } });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const close = () => {
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
  };
  try { await video.play(); } catch (error) { close(); throw error; }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) { close(); throw new Error("Camera capture is unavailable."); }
  return {
    stream, close,
    frame: () => {
      if (!stream.active) throw new Error("Camera disconnected.");
      if (!video.videoWidth || video.readyState < 2) return undefined;
      const scale = Math.min(1, 336 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.8);
    },
  };
}
