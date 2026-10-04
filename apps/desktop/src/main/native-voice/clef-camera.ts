import { CAMERA_VIBES, CAMERA_GESTURES, VOICE_CAMERA_QUESTIONS, type VoiceCameraObservation } from "../../shared/native-voice-camera";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Clef response.");
  return value as Record<string, unknown>;
}
function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid Clef confidence.");
  return value;
}
export function parseClefObservation(value: unknown): VoiceCameraObservation {
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
    latencyMs: typeof data.latency_ms === "number" && Number.isFinite(data.latency_ms) ? data.latency_ms : 0,
  };
}

const CLEF_URL = "http://127.0.0.1:8787";
const CLEF_HEALTH_TIMEOUT_MS = 1000;

/**
 * Decisions the PwrSuiteLab Clef runtime is running or holding, from its
 * `/health` route, which answers without waiting for the model lock. The
 * count includes requests a client abandoned: Clef finishes those anyway.
 * Undefined when the server has no such route or does not answer promptly.
 */
export async function clefRequestsInFlight(signal: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetch(`${CLEF_URL}/health`, {
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

export async function classifyVoiceCamera(image: string, signal: AbortSignal, warming = false): Promise<VoiceCameraObservation> {
  // clef-webcam warms the model before opening its API. Keep one request
  // outstanding and tolerate temporary unavailability within the caller's
  // deadline, while opt-out/teardown cancels both fetch and backoff.
  while (true) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await fetch(`${CLEF_URL}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image, questions: VOICE_CAMERA_QUESTIONS,
          state: "A live webcam frame from a laptop.",
        }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted || !warming) throw error;
    }
    if (response?.ok) return parseClefObservation(await response.json());
    if (response && (!warming || (response.status !== 429 && response.status < 500))) {
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
