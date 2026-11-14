import {
  redactOpenAIDecisionsText,
  type OpenAIDecisionQuestion,
} from "@pwragent/shared/openai-decisions";
import { postSystemOne, systemOneErrorDetail, type SystemOneTarget } from "../decision/system-one";
import type { OpenAIDecisionsFailureCode } from "./openai-decisions-client";

/**
 * Registered decisions on a System One provider: TypeSafe's Jev, or a local
 * decision model such as Clef. System One asks keyed `noul` (yes/no) and
 * `choice` questions about a text `state`, so a stored definition maps as:
 *
 * - predicate -> `noul`; the answer's probability is `answers[key].noul`.
 * - choice -> `choice` whose criteria keys are the choice values.
 * - score -> `choice` over the ordered level labels. PwrAgent computes the
 *   score as the probability-weighted level index, which is what an OpenAI
 *   score answer reports, so both providers return one answer shape.
 *
 * The prefix and the input become the state. System One takes no images.
 */

export type SystemOneDecisionRequest = {
  state: string;
  questions: Record<string, Record<string, unknown>>;
  /** The key each stored question was sent under, in stored order. */
  keys: string[];
};

export type RegisteredDecisionAnswer =
  | { type: "predicate"; name?: string; probability: number }
  | {
      type: "choice";
      name?: string;
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      name?: string;
      /** Probability-weighted 0-based level index; can fall between levels. */
      score: number;
      probabilities: Array<{ value: number; label: string; probability: number }>;
      confidence: number;
    }
  | { type: "unavailable"; name?: string; reason: string };

/** Each question's key: its own name, or q1, q2, ... in stored order. */
export function systemOneQuestionKeys(questions: readonly OpenAIDecisionQuestion[]): string[] {
  const taken = new Set(questions.flatMap((question) => question.name !== undefined ? [question.name] : []));
  let next = 1;
  return questions.map((question) => {
    if (question.name !== undefined) return question.name;
    while (taken.has(`q${next}`)) next += 1;
    const key = `q${next}`;
    taken.add(key);
    next += 1;
    return key;
  });
}

export function buildSystemOneDecisionRequest(params: {
  questions: readonly OpenAIDecisionQuestion[];
  prefix?: string;
  input: unknown;
}): SystemOneDecisionRequest {
  const keys = systemOneQuestionKeys(params.questions);
  const inputText = typeof params.input === "string"
    ? params.input
    : JSON.stringify(params.input, null, 2);
  const state = params.prefix ? `${params.prefix}\n\n${inputText}` : inputText;
  const questions: SystemOneDecisionRequest["questions"] = {};
  params.questions.forEach((question, index) => {
    const key = keys[index]!;
    if (question.type === "predicate") {
      questions[key] = {
        type: "noul",
        instructions: question.instructions,
        criteria: { true: "yes", false: "no" },
      };
    } else if (question.type === "choice") {
      questions[key] = {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(question.choices.map((choice) => [choice.value, choice.description ?? null])),
      };
    } else {
      questions[key] = {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(question.levels.map((level) => [level.label, level.description ?? null])),
      };
    }
  });
  return { state, questions, keys };
}

/**
 * Reads `answers` in stored question order. A missing or malformed answer is
 * reported as unavailable for that question rather than failing the rest.
 */
export function readSystemOneDecisionAnswers(
  body: unknown,
  questions: readonly OpenAIDecisionQuestion[],
  keys: readonly string[],
): RegisteredDecisionAnswer[] {
  const answers = record(record(body).answers);
  return questions.map((question, index) => {
    const name = question.name;
    const named = name !== undefined ? { name } : {};
    const answer = record(answers[keys[index]!]);
    if (question.type === "predicate") {
      const probability = asProbability(answer.noul);
      return probability === undefined
        ? { type: "unavailable", ...named, reason: "The answer had no yes/no probability." }
        : { type: "predicate", ...named, probability };
    }
    const scores = record(answer.probabilities);
    if (question.type === "choice") {
      const values = question.choices.map((choice) => choice.value);
      const probabilities = Object.fromEntries(values.map((value) => [value, asProbability(scores[value]) ?? 0]));
      const choice = typeof answer.choice === "string" && values.includes(answer.choice) ? answer.choice : undefined;
      return choice === undefined
        ? { type: "unavailable", ...named, reason: "The answer named no listed choice." }
        : { type: "choice", ...named, choice, probabilities, confidence: probabilities[choice] ?? 0 };
    }
    const levels = question.levels.map((level, value) => ({
      value,
      label: level.label,
      probability: asProbability(scores[level.label]) ?? 0,
    }));
    const total = levels.reduce((sum, level) => sum + level.probability, 0);
    if (total <= 0) {
      return { type: "unavailable", ...named, reason: "The answer gave no level probabilities." };
    }
    return {
      type: "score",
      ...named,
      score: levels.reduce((sum, level) => sum + level.value * level.probability, 0) / total,
      probabilities: levels,
      confidence: Math.max(...levels.map((level) => level.probability)),
    };
  });
}

function asProbability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const SYSTEM_ONE_DECISION_TIMEOUT_MS = 30_000;

export type SystemOneDecisionResult =
  | { ok: true; model?: string; answers: RegisteredDecisionAnswer[] }
  | { ok: false; code: OpenAIDecisionsFailureCode; status?: number; detail?: string };

/**
 * One System One request. No retry: TypeSafe documents no Retry-After, and a
 * local server's queue is its own. The key, when there is one, is redacted
 * from any server text that reaches the caller.
 */
export async function postSystemOneDecision(params: {
  target: SystemOneTarget;
  request: SystemOneDecisionRequest;
  questions: readonly OpenAIDecisionQuestion[];
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SystemOneDecisionResult> {
  const timeout = AbortSignal.timeout(params.timeoutMs ?? SYSTEM_ONE_DECISION_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const secrets = [params.target.apiKey];
  let response: Response;
  try {
    response = await postSystemOne(
      params.target,
      { state: params.request.state, questions: params.request.questions },
      { signal, ...(params.fetch ? { fetch: params.fetch } : {}) },
    );
  } catch (error) {
    return {
      ok: false,
      code: "upstream_error",
      detail: params.signal?.aborted
        ? "The request was cancelled."
        : timeout.aborted
          ? "The request timed out."
          : redactOpenAIDecisionsText(error instanceof Error ? error.message : String(error), secrets),
    };
  }
  if (!response.ok) {
    const detail = await systemOneErrorDetail(response);
    const failure = {
      status: response.status,
      ...(detail ? { detail: redactOpenAIDecisionsText(detail, secrets) } : {}),
    };
    if (response.status === 401 || response.status === 403) return { ok: false, code: "credential_rejected", ...failure };
    if (response.status === 404) return { ok: false, code: "model_unavailable", ...failure };
    if (response.status === 429) return { ok: false, code: "rate_limited", ...failure };
    if (response.status === 503 || response.status === 529) return { ok: false, code: "overloaded", ...failure };
    return { ok: false, code: "upstream_error", ...failure };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      code: "upstream_error",
      status: response.status,
      detail: params.signal?.aborted
        ? "The request was cancelled."
        : timeout.aborted ? "The request timed out." : "The response was not a JSON object.",
    };
  }
  const model = (body as Record<string, unknown>).model;
  return {
    ok: true,
    ...(typeof model === "string" ? { model } : {}),
    answers: readSystemOneDecisionAnswers(body, params.questions, params.request.keys),
  };
}
