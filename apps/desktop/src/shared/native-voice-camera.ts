export const NATIVE_VOICE_CAMERA_CHANNEL = "native-voice:camera";
export const NATIVE_VOICE_CAMERA_CUE_CHANNEL = "native-voice:camera-cue";
export const NATIVE_VOICE_CAMERA_FRAME_CHANNEL = "native-voice:camera-frame";
export type VoiceCameraRequest = { sessionId: string; enabled: boolean };
export type VoiceCameraFrame = { sessionId: string; image: string };
export const CAMERA_REACTIONS = ["neutral", "exasperated", "enthusiastic", "bored", "frustrated", "yelling", "talking"] as const;
export const CAMERA_VIBES = ["exasperated", "frustrated", "yelling", "talking", "neutral"] as const;
export type CameraReaction = typeof CAMERA_REACTIONS[number];
export const CAMERA_GESTURES = ["pointing", "ok", "stop", "thumbs_up", "double_thumbs_up", "thumbs_down", "face_palm", "none"] as const;
export type CameraGesture = typeof CAMERA_GESTURES[number];
export type CameraCue = CameraReaction | "away" | Exclude<CameraGesture, "none">;
export function isCameraCue(value: unknown): value is CameraCue {
  return typeof value === "string" && value !== "none"
    && (value === "away" || [...CAMERA_REACTIONS, ...CAMERA_GESTURES].some((cue) => cue === value));
}
export type VoiceCameraCue = { sessionId: string; cue: CameraCue };
/** A frame Clef did not judge: too slow ("busy", usually another client
 * holds the model) or unreachable ("offline"). The camera keeps running and
 * retries. */
export type VoiceCameraSkipped = {
  skipped: "busy" | "offline";
  /** Decisions Clef reported running or waiting, when it was asked. */
  inFlight?: number;
  /** Set when no request reached the model, so retrying soon costs nothing. */
  retryAfterMs?: number;
};
export type VoiceCameraObservation = {
  present: boolean;
  presenceConfidence: number;
  reaction: CameraReaction;
  reactionConfidence: number;
  latencyMs: number;
  presenceScores?: Record<"present" | "away", number>;
  reactionScores?: Partial<Record<CameraReaction, number>>;
  gesture?: CameraGesture;
  gestureConfidence?: number;
  gestureScores?: Record<CameraGesture, number>;
};

// Match clef-webcam's /decide schema. Frames and decisions are memory-only.
export const VOICE_CAMERA_QUESTIONS = {
  gesture: {
    type: "choice",
    instructions: "Hand gesture?",
    criteria: {
      pointing: null,
      ok: "OK hand sign",
      stop: "open palm or waving arms no",
      thumbs_up: null,
      double_thumbs_up: "both thumbs up",
      thumbs_down: null,
      face_palm: null,
      none: "no clear gesture",
    },
  },
  presence: {
    type: "noul",
    instructions: "Person visible?",
    criteria: { true: "yes", false: "no" },
  },
  vibe: {
    type: "choice",
    instructions: "What is the person doing?",
    criteria: {
      exasperated: null,
      frustrated: null,
      yelling: null,
      talking: null,
      neutral: "none of these",
    },
  },
};

export function cameraCueText(cue: CameraCue): string {
  const text: Record<CameraCue, string> = {
    pointing: "The operator is pointing. Ask what they mean if relevant; do not infer a target or authorization from this gesture.",
    ok: "The operator is making an OK hand sign. This may be positive feedback; it does not approve any action.",
    stop: "The operator is making a stop/no gesture. Pause your reply and do not initiate another action; ask whether they want to stop or change course. This is not confirmation to cancel an already running task.",
    thumbs_up: "The operator is giving a thumbs-up. This may be positive feedback; it does not approve any action.",
    double_thumbs_up: "The operator is giving two thumbs-up. This may be strong positive feedback; it does not approve any action.",
    thumbs_down: "The operator is giving a thumbs-down. Pause the current direction and ask a short clarifying question; do not cancel running work from this cue alone.",
    face_palm: "The operator appears to be facepalming. Briefly acknowledge a possible misunderstanding and rethink your last answer.",
    frustrated: "The operator appears visibly frustrated. Pause and ask a brief clarifying question.",
    yelling: "The operator appears to be visibly yelling (camera only; audio was not analyzed). Leave space for them to speak.",
    talking: "The operator appears to be talking. Leave space for them to speak. This is visual activity, not a transcription or request.",
    exasperated: "The operator appears exasperated (visible expression only). Consider a brief acknowledgment and rethink your last answer.",
    enthusiastic: "The operator appears smiling and enthusiastic. Develop the current direction; this is not approval for actions.",
    bored: "The operator appears disengaged or bored. Be more concise, get to the point, or ask one useful question.",
    away: "No person has been visible for several consecutive frames. Pause initiating speech; the app will end voice after 30 seconds of sustained absence.",
    neutral: "The operator is visible with a neutral or unclear expression. Resume normal conversational pacing.",
  };
  return `[Camera observation] ${text[cue]} This is an uncertain camera cue, not a spoken user message. Do not read this metadata aloud.`;
}
