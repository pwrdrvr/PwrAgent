import type { CameraCue, CameraGesture, VoiceCameraObservation } from "../../../../shared/native-voice-camera";

export const CAMERA_AWAY_END_MS = 30_000;
export const CAMERA_SAMPLE_GAP_MS = 10_000;
const REACTION_DEBOUNCE_MS = 1500;
const CUE_COOLDOWN_MS = 8000;
export type CameraDecision = { cue?: CameraCue; end?: boolean };

/** Require consecutive confident samples; missing/uncertain frames never count as absence. */
export class CameraCueFilter {
  status = "Waiting for a decision";
  gestureStatus = "Waiting for a gesture decision";
  private gestureCandidate?: CameraGesture;
  private gestureSince = 0;
  private gestureSamples = 0;
  private lastGesture?: CameraGesture;
  private lastGestureSent = -Infinity;
  private candidate?: CameraCue;
  private since = 0;
  private samples = 0;
  private lastSample?: number;
  private lastCue?: CameraCue;
  private lastSent = -Infinity;
  private awaySince?: number;

  resetContinuity(): void {
    this.awaySince = undefined;
    this.candidate = undefined;
    this.lastSample = undefined;
    this.gestureCandidate = undefined;
    this.gestureSamples = 0;
  }

  observe(observation: VoiceCameraObservation, now: number): CameraDecision {
    if (this.lastSample !== undefined && now - this.lastSample > CAMERA_SAMPLE_GAP_MS) this.resetContinuity();
    let gesture: CameraCue | undefined;
    if (observation.present && observation.presenceConfidence >= 0.8) {
      gesture = this.observeGesture(observation, now);
    } else {
      this.gestureCandidate = undefined;
      this.gestureStatus = "Gesture requires confident presence";
      if (!observation.present && observation.presenceConfidence >= 0.8) this.lastGesture = undefined;
    }
    const stopHeld = observation.present && observation.presenceConfidence >= 0.8
      && (observation.gesture === "stop" || observation.gesture === "thumbs_down")
      && (observation.gestureConfidence ?? 0) >= 0.85;
    const decision = this.observeReaction(observation, now, gesture !== undefined || stopHeld);
    return gesture ? { cue: gesture } : decision;
  }

  private observeGesture(observation: VoiceCameraObservation, now: number): CameraCue | undefined {
    const gesture = observation.gesture;
    const urgent = gesture === "stop" || gesture === "thumbs_down";
    const threshold = urgent ? 0.85 : 0.8;
    if (!gesture || (observation.gestureConfidence ?? 0) < threshold) {
      this.gestureCandidate = undefined;
      this.gestureStatus = `Gesture confidence below ${threshold * 100}%`;
      return;
    }
    if (gesture !== this.gestureCandidate) {
      this.gestureCandidate = gesture;
      this.gestureSince = now;
      this.gestureSamples = 0;
    }
    this.gestureSamples++;
    this.gestureStatus = "Collecting consecutive gesture frames";
    const quick = urgent || gesture === "none";
    if (this.gestureSamples < (quick ? 2 : 3) || now - this.gestureSince < (quick ? 500 : REACTION_DEBOUNCE_MS)) return;
    if (gesture === this.lastGesture) { this.gestureStatus = "Repeated gesture suppressed"; return; }
    if (gesture === "none") { this.lastGesture = gesture; this.gestureStatus = "No gesture"; return; }
    if (!urgent && now - this.lastGestureSent < CUE_COOLDOWN_MS) { this.gestureStatus = "Eight-second gesture cooldown"; return; }
    this.lastGesture = gesture;
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
      return {};
    }
    let cue: CameraCue;
    if (!observation.present) {
      this.awaySince ??= now;
      if (now - this.awaySince >= CAMERA_AWAY_END_MS) return { end: true };
      cue = "away";
    } else {
      this.awaySince = undefined;
      if (observation.reactionConfidence < 0.7) {
        this.status = "Reaction confidence below 70%";
        this.candidate = undefined;
        return {};
      }
      cue = observation.reaction;
    }
    if (holdReaction) { this.status = "Vibe cue held for gesture"; return {}; }
    if (cue !== this.candidate) {
      this.candidate = cue;
      this.since = now;
      this.samples = 0;
    }
    this.samples++;
    if (this.samples < 3 || now - this.since < REACTION_DEBOUNCE_MS) return {};
    if (cue === this.lastCue) { this.status = "Repeated cue suppressed"; return {}; }
    if (cue !== "away" && this.lastCue !== "away" && now - this.lastSent < CUE_COOLDOWN_MS) { this.status = "Eight-second cue cooldown"; return {}; }
    this.lastCue = cue;
    this.lastSent = now;
    this.status = "Cue ready";
    return { cue };
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
