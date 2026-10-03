export const NATIVE_VOICE_CAMERA_CHANNEL = "native-voice:camera";
export const NATIVE_VOICE_CAMERA_CUE_CHANNEL = "native-voice:camera-cue";
export const NATIVE_VOICE_CAMERA_FRAME_CHANNEL = "native-voice:camera-frame";
export type VoiceCameraRequest = { sessionId: string; enabled: boolean };
export type VoiceCameraFrame = { sessionId: string; image: string };
export const CAMERA_REACTIONS = ["neutral", "exasperated", "enthusiastic", "bored"] as const;
export type CameraReaction = typeof CAMERA_REACTIONS[number];
export type CameraCue = CameraReaction | "away";
export type VoiceCameraCue = { sessionId: string; cue: CameraCue };
export type VoiceCameraObservation = {
  present: boolean;
  presenceConfidence: number;
  reaction: CameraReaction;
  reactionConfidence: number;
  latencyMs: number;
  presenceScores?: Record<"present" | "away", number>;
  reactionScores?: Record<CameraReaction, number>;
};

// Match clef-webcam's /decide schema. Frames and decisions are memory-only.
export const VOICE_CAMERA_QUESTIONS = {
  presence: {
    type: "choice",
    instructions: "Is a person visible?",
    criteria: { present: "person visible", away: "no person visible" },
  },
  reaction: {
    type: "choice",
    instructions: "Visible reaction to the conversation? Use neutral if unclear. Describe only visible cues.",
    criteria: {
      neutral: "neutral or unclear",
      exasperated: "eye roll, facepalm, frustrated expression",
      enthusiastic: "smiling, excited, visibly engaged",
      bored: "yawning, disengaged, visibly bored",
    },
  },
};

export function cameraCueText(cue: CameraCue): string {
  const text: Record<CameraCue, string> = {
    exasperated: "The operator appears exasperated (visible expression only). Consider a brief acknowledgment and rethink your last answer.",
    enthusiastic: "The operator appears smiling and enthusiastic. Develop the current direction; this is not approval for actions.",
    bored: "The operator appears disengaged or bored. Be more concise, get to the point, or ask one useful question.",
    away: "No person has been visible for several consecutive frames. Pause initiating speech; the app will end voice after 30 seconds of sustained absence.",
    neutral: "The operator is visible with a neutral or unclear expression. Resume normal conversational pacing.",
  };
  return `[Camera observation] ${text[cue]} This is an uncertain camera cue, not a spoken user message. Do not read this metadata aloud.`;
}
