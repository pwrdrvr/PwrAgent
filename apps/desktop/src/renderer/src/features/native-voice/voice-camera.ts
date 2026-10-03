import type { CameraCue, VoiceCameraObservation } from "../../../../shared/native-voice-camera";

export const CAMERA_AWAY_END_MS = 30_000;
export const CAMERA_SAMPLE_GAP_MS = 10_000;
const REACTION_DEBOUNCE_MS = 1500;
const CUE_COOLDOWN_MS = 8000;
export type CameraDecision = { cue?: CameraCue; end?: boolean };

/** Require consecutive confident samples; missing/uncertain frames never count as absence. */
export class CameraCueFilter {
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
  }

  observe(observation: VoiceCameraObservation, now: number): CameraDecision {
    if (this.lastSample !== undefined && now - this.lastSample > CAMERA_SAMPLE_GAP_MS) this.resetContinuity();
    this.lastSample = now;
    if (observation.presenceConfidence < 0.8) {
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
        this.candidate = undefined;
        return {};
      }
      cue = observation.reaction;
    }
    if (cue !== this.candidate) {
      this.candidate = cue;
      this.since = now;
      this.samples = 0;
    }
    this.samples++;
    if (this.samples < 3 || now - this.since < REACTION_DEBOUNCE_MS || cue === this.lastCue) return {};
    if (cue !== "away" && this.lastCue !== "away" && now - this.lastSent < CUE_COOLDOWN_MS) return {};
    this.lastCue = cue;
    // Initial neutral is useful locally, but doesn't need a voice interruption.
    if (cue === "neutral" && this.lastSent === -Infinity) return {};
    this.lastSent = now;
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
