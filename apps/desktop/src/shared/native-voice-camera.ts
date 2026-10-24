export const NATIVE_VOICE_CAMERA_CHANNEL = "native-voice:camera";
export const NATIVE_VOICE_CAMERA_CUE_CHANNEL = "native-voice:camera-cue";
export const NATIVE_VOICE_CAMERA_FRAME_CHANNEL = "native-voice:camera-frame";
export const NATIVE_VOICE_CAMERA_REPEAT_CHANNEL = "native-voice:camera-repeat";
export type VoiceCameraRequest = { sessionId: string; enabled: boolean };
/**
 * A burst of webcam frames, oldest first, `VOICE_CAMERA_BURST.spacingMs`
 * apart. Motion such as a nod shows only across frames, never in one still.
 */
export type VoiceCameraFrame = { sessionId: string; images: string[] };
/**
 * Four frames 100ms apart cover 300ms, about half a nod. Each extra frame
 * costs about 90 input tokens: on an M5 Max, one frame with the head
 * question took 608ms and four took 811ms (1.64 vs 1.23 decisions/s).
 */
export const VOICE_CAMERA_BURST = { frames: 4, spacingMs: 100 } as const;
export const CAMERA_REACTIONS = ["neutral", "exasperated", "enthusiastic", "bored", "frustrated", "yelling", "talking"] as const;
export const CAMERA_VIBES = ["exasperated", "frustrated", "yelling", "talking", "neutral"] as const;
export type CameraReaction = typeof CAMERA_REACTIONS[number];
export const CAMERA_GESTURES = ["pointing", "ok", "stop", "thumbs_up", "double_thumbs_up", "thumbs_down", "face_palm", "none"] as const;
export type CameraGesture = typeof CAMERA_GESTURES[number];
export const CAMERA_HEAD_MOTIONS = ["nodding", "shaking", "still"] as const;
export type CameraHeadMotion = typeof CAMERA_HEAD_MOTIONS[number];
/** A nod or a head shake, as a cue. */
export const CAMERA_HEAD_CUES = ["head_nod", "head_shake"] as const;
export type CameraHeadCue = typeof CAMERA_HEAD_CUES[number];
export type CameraCue = CameraReaction | "away" | Exclude<CameraGesture, "none"> | CameraHeadCue;
export function isCameraCue(value: unknown): value is CameraCue {
  return typeof value === "string" && value !== "none"
    && (value === "away" || [...CAMERA_REACTIONS, ...CAMERA_GESTURES, ...CAMERA_HEAD_CUES].some((cue) => cue === value));
}
export type VoiceCameraCue = { sessionId: string; cue: CameraCue };
/**
 * One line of the voice conversation, `ago` whole seconds before it was
 * read. Built from the controller's memory-only rows and never persisted.
 */
export type VoiceCameraConversationLine = { ago: number; speaker: "operator" | "voice" | "cue" | "action"; text: string };
export const VOICE_CAMERA_CONVERSATION_LIMITS = { lines: 12, seconds: 90, chars: 240 } as const;
/** Before a gesture already sent is sent again: has the voice moved on since? */
export type VoiceCameraRepeatCheck = { sessionId: string; conversation: VoiceCameraConversationLine[] };
/** Probability that the voice said something substantive after the latest cue. */
export type VoiceCameraRepeatVerdict = { movedOn: number };
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
  /** Asked only of a burst: one still cannot show motion. */
  head?: CameraHeadMotion;
  headConfidence?: number;
  headScores?: Record<CameraHeadMotion, number>;
};

// System One questions (TypeSafe's schema). Frames and decisions are memory-only.
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

// Asked of the conversation alone, in its own request. In one joint request
// with the frame, the transcript shifted the frame's own answers: a photo with
// nobody in it went from 0.21 to 0.50 "stop" and 0.42 to 0.71 "present" when
// the conversation mentioned a stop cue. This wording separated all ten
// probe conversations, sent text only (bare acknowledgments 0.03 to 0.33,
// substantive replies 0.76 to 0.96); see "Camera context integration" in
// docs/native-live-voice.md.
export const VOICE_CAMERA_REPEAT_QUESTIONS = {
  moved_on: {
    type: "noul",
    instructions: "Since the latest camera cue, has the voice said anything beyond acknowledging it?",
    criteria: {
      true: "yes: new information, a new plan, a change of course, or resumed work",
      false: "no: silence, or only acknowledging, pausing, or asking what to do",
    },
  },
};

const CONVERSATION_SPEAKERS = { operator: "operator", voice: "voice", cue: "camera cue", action: "voice action" } as const;
export function isCameraConversation(value: unknown): value is VoiceCameraConversationLine[] {
  const limits = VOICE_CAMERA_CONVERSATION_LIMITS;
  return Array.isArray(value) && value.length <= limits.lines && value.every((line: unknown) => {
    if (!line || typeof line !== "object") return false;
    const { ago, speaker, text } = line as Record<string, unknown>;
    return typeof ago === "number" && Number.isInteger(ago) && ago >= 0 && ago <= limits.seconds
      && typeof speaker === "string" && Object.hasOwn(CONVERSATION_SPEAKERS, speaker)
      && typeof text === "string" && text.length <= limits.chars;
  });
}
/** Clef's `state` for the repeat check: one line per row, oldest first. */
export function cameraConversationState(lines: VoiceCameraConversationLine[]): string {
  // Collapse whitespace so spoken text cannot start a line that reads as a cue.
  const rows = lines.map(({ ago, speaker, text }) => `-${ago}s ${CONVERSATION_SPEAKERS[speaker]}: ${text.replace(/\s+/g, " ").trim()}`);
  return ["Voice conversation, oldest first, in seconds before now:", ...rows].join("\n");
}

// Asked only when a request carries two or more frames.
export const VOICE_CAMERA_HEAD_QUESTION = {
  type: "choice",
  instructions: "Head movement across the frames?",
  criteria: {
    nodding: "nodding yes: head moving up and down",
    shaking: "shaking no: head turning side to side",
    still: "no head movement",
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
    head_nod: "The operator nodded yes. This may be agreement or a go-ahead to keep talking; it does not approve any action.",
    head_shake: "The operator shook their head no. Pause the current direction and ask a short clarifying question; do not cancel running work from this cue alone.",
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
