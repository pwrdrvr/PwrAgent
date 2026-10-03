import { CAMERA_REACTIONS, VOICE_CAMERA_QUESTIONS, type VoiceCameraObservation } from "../../shared/native-voice-camera";

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
  const reaction = object(answers.reaction);
  if (presence.type !== "choice" || reaction.type !== "choice"
    || (presence.choice !== "present" && presence.choice !== "away")
    || !CAMERA_REACTIONS.includes(reaction.choice as VoiceCameraObservation["reaction"])) throw new Error("Invalid Clef decisions.");
  const presenceProbabilities = object(presence.probabilities);
  const reactionProbabilities = object(reaction.probabilities);
  for (const key of ["present", "away"]) probability(presenceProbabilities[key]);
  for (const key of CAMERA_REACTIONS) probability(reactionProbabilities[key]);
  return {
    present: presence.choice === "present",
    presenceConfidence: probability(presenceProbabilities[presence.choice]),
    reaction: reaction.choice as VoiceCameraObservation["reaction"],
    reactionConfidence: probability(reactionProbabilities[String(reaction.choice)]),
    latencyMs: typeof data.latency_ms === "number" && Number.isFinite(data.latency_ms) ? data.latency_ms : 0,
  };
}

export async function classifyVoiceCamera(image: string, signal: AbortSignal): Promise<VoiceCameraObservation> {
  const response = await fetch("http://127.0.0.1:8787/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image, questions: VOICE_CAMERA_QUESTIONS,
      state: "A laptop webcam frame during a voice conversation. Classify visible presence and expression only; use neutral when ambiguous.",
    }),
    signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Clef returned HTTP ${response.status}.`);
  return parseClefObservation(await response.json());
}
