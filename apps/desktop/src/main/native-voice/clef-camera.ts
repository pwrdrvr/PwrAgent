import {
  CAMERA_VIBES, CAMERA_GESTURES, VOICE_CAMERA_QUESTIONS, VOICE_CAMERA_REPEAT_QUESTIONS, cameraConversationState,
  type VoiceCameraConversationLine, type VoiceCameraObservation, type VoiceCameraRepeatVerdict,
} from "../../shared/native-voice-camera";
import {
  isSystemOneRejection,
  postSystemOne,
  systemOneErrorDetail,
  systemOneHeaders,
  SystemOneRejected,
  type SystemOneRequest,
  type SystemOneTarget,
} from "../decision/system-one";

/**
 * Every camera decision request is built here. A frame is judged alone; the
 * conversation is judged in its own text-only request, because a transcript
 * in the frame's `state` biases the frame's own answers.
 */
export function cameraDecisionRequest(input: { image: string } | { conversation: VoiceCameraConversationLine[] }): SystemOneRequest {
  return "image" in input
    ? { state: "A live webcam frame from a laptop.", questions: VOICE_CAMERA_QUESTIONS, images: [input.image] }
    : { state: cameraConversationState(input.conversation), questions: VOICE_CAMERA_REPEAT_QUESTIONS };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Clef response.");
  return value as Record<string, unknown>;
}
function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid Clef confidence.");
  return value;
}
/** A System One answer to the camera questions. It carries no timing, so the caller measures `latencyMs`. */
export function parseClefObservation(value: unknown, latencyMs: number): VoiceCameraObservation {
  const data = object(value);
  const answers = object(data.answers);
  const presence = object(answers.presence);
  const reaction = object(answers.vibe ?? answers.reaction);
  if (answers.vibe && answers.gesture === undefined) throw new Error("Missing Clef gesture.");
  const reactionProbabilities = object(reaction.probabilities);
  // Accept the original four-choice response for compatibility; the new vibe
  // question must return every requested score, with no arbitrary cue text.
  const reactionKeys = answers.vibe ? CAMERA_VIBES : ["neutral", "exasperated", "enthusiastic", "bored"] as const;
  if (reaction.type !== "choice" || !reactionKeys.some((key) => key === reaction.choice)) throw new Error("Invalid Clef decisions.");
  const reactionScores = Object.fromEntries(reactionKeys.map((key) => [key, probability(reactionProbabilities[key])]));
  let presenceScores: { present: number; away: number };
  let present: boolean;
  if (presence.type === "noul") {
    const score = probability(presence.noul);
    presenceScores = { present: score, away: 1 - score };
    present = score >= 0.5;
  } else if (presence.type === "choice" && (presence.choice === "present" || presence.choice === "away")) {
    const scores = object(presence.probabilities);
    presenceScores = { present: probability(scores.present), away: probability(scores.away) };
    present = presence.choice === "present";
  } else throw new Error("Invalid Clef presence.");
  let gesture: VoiceCameraObservation["gesture"];
  let gestureScores: VoiceCameraObservation["gestureScores"];
  if (answers.gesture !== undefined) {
    const answer = object(answers.gesture);
    if (answer.type !== "choice" || !CAMERA_GESTURES.includes(answer.choice as NonNullable<typeof gesture>)) throw new Error("Invalid Clef gesture.");
    const scores = object(answer.probabilities);
    gesture = answer.choice as NonNullable<typeof gesture>;
    gestureScores = Object.fromEntries(CAMERA_GESTURES.map((key) => [key, probability(scores[key])])) as NonNullable<typeof gestureScores>;
  }
  return {
    present, presenceScores, presenceConfidence: present ? presenceScores.present : presenceScores.away,
    reaction: reaction.choice as VoiceCameraObservation["reaction"], reactionScores,
    reactionConfidence: probability(reactionProbabilities[String(reaction.choice)]),
    ...(gesture && gestureScores ? { gesture, gestureScores, gestureConfidence: gestureScores[gesture] } : {}),
    latencyMs,
  };
}

const CLEF_HEALTH_TIMEOUT_MS = 1000;

/**
 * Decisions the PwrSuiteLab Clef runtime is running or holding, from its
 * `/health` route, which answers without waiting for the model lock. The
 * count includes requests a client abandoned: Clef finishes those anyway.
 * Undefined when the server has no such route or does not answer promptly.
 */
export async function clefRequestsInFlight(target: SystemOneTarget, signal: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetch(`${target.endpoint}/health`, {
      headers: systemOneHeaders(target.apiKey),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CLEF_HEALTH_TIMEOUT_MS)]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const body: unknown = await response.json();
    const count = body && typeof body === "object" ? (body as Record<string, unknown>).requests_processing : undefined;
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

export function parseClefRepeatVerdict(value: unknown): VoiceCameraRepeatVerdict {
  const answer = object(object(object(value).answers).moved_on);
  if (answer.type !== "noul") throw new Error("Invalid Clef repeat check.");
  return { movedOn: probability(answer.noul) };
}

/**
 * Asks the local decision model about one frame, through the System One API
 * with Clef's `images` extension. Throws {@link SystemOneRejected} when the
 * server refuses the request itself (a wrong model id, a refused key).
 */
export async function classifyVoiceCamera(
  target: SystemOneTarget,
  image: string,
  signal: AbortSignal,
  warming = false,
): Promise<VoiceCameraObservation> {
  const { body, latencyMs } = await decide(target, cameraDecisionRequest({ image }), signal, warming);
  return parseClefObservation(body, latencyMs);
}

/**
 * Asks whether the voice moved on since the latest camera cue. Text only:
 * no frame goes with it. Throws {@link SystemOneRejected} like a frame.
 */
export async function judgeVoiceCameraRepeat(
  target: SystemOneTarget,
  conversation: VoiceCameraConversationLine[],
  signal: AbortSignal,
): Promise<VoiceCameraRepeatVerdict> {
  const { body } = await decide(target, cameraDecisionRequest({ conversation }), signal, false);
  return parseClefRepeatVerdict(body);
}

async function decide(
  target: SystemOneTarget,
  request: SystemOneRequest,
  signal: AbortSignal,
  warming: boolean,
): Promise<{ body: unknown; latencyMs: number }> {
  // The server may still be loading or compiling the question schema. Keep
  // one request outstanding and tolerate temporary unavailability within the
  // caller's deadline, while opt-out/teardown cancels both fetch and backoff.
  while (true) {
    signal.throwIfAborted();
    let response: Response | undefined;
    const started = performance.now();
    try {
      response = await postSystemOne(target, request, { signal });
    } catch (error) {
      if (signal.aborted || !warming) throw error;
    }
    if (response?.ok) {
      const body: unknown = await response.json();
      return { body, latencyMs: performance.now() - started };
    }
    if (response && isSystemOneRejection(response.status)) {
      throw new SystemOneRejected(response.status, await systemOneErrorDetail(response));
    }
    if (response && (!warming || (response.status !== 429 && response.status < 500))) {
      await response.body?.cancel();
      throw new Error(`Clef returned HTTP ${response.status}.`);
    }
    // Release the failed response before the next attempt.
    await response?.body?.cancel();
    await waitForClefRetry(signal);
  }
}

function waitForClefRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, 1000);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
